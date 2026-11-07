import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invoke } from '@tauri-apps/api/core';
import { monaco } from './monaco';
import { languageForCodeFence } from './languages';

type Props = { text: string; document: string; english: boolean; report: (message: string) => void };

function Highlight({ text, language }: { text: string; language: string }) {
  const [html, setHtml] = useState<{ text: string; html: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const id = languageForCodeFence(language);
    if (monaco.languages.getLanguages().some(l => l.id === id)) {
      void monaco.editor.colorize(text, id, {}).then(result => {
        if (!cancelled) setHtml({ text, html: result });
      }).catch(() => { if (!cancelled) setHtml(null); });
    }
    return () => { cancelled = true; };
  }, [text, language]);
  // HTML is produced exclusively by Monaco's escaping tokenizer, never by Markdown HTML.
  return html?.text === text ? <code dangerouslySetInnerHTML={{ __html: html.html }} /> : <code>{text}</code>;
}

function Image({ src, alt, document, remote, english }: {
  src: string; alt?: string; document: string; remote: boolean; english: boolean;
}) {
  const [local, setLocal] = useState<{ source: string; url: string } | null>(null);
  const [error, setError] = useState('');
  const isRemote = /^https?:\/\//i.test(src);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setError('');
    if (!src || isRemote) return;
    if (!document) { setError(english ? 'Save the document first' : '請先儲存文件'); return; }
    let source: string;
    try { source = decodeURIComponent(src.split(/[?#]/)[0]); }
    catch { setError(english ? 'Invalid image path' : '圖片路徑無效'); return; }
    void invoke<{ mime: string; data: number[] }>('read_image', { document, source }).then(asset => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(asset.data)], { type: asset.mime }));
      setLocal({ source: src, url: objectUrl });
    }).catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, document, english, isRemote]);
  if (isRemote) return remote ? <img src={src} alt={alt ?? ''} referrerPolicy="no-referrer" loading="lazy" />
    : <em>{english ? 'Remote image blocked' : '已封鎖遠端圖片'}: {alt || src}</em>;
  if (error) return <em className="image-error">{alt}: {error}</em>;
  return local?.source === src ? <img src={local.url} alt={alt ?? ''} /> : <em>{english ? 'Loading image…' : '圖片載入中…'}</em>;
}

export function MarkdownPreview({ text, document, english, report }: Props) {
  const [rendered, setRendered] = useState(text);
  const [remote, setRemote] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setRendered(text), 120); return () => clearTimeout(timer); }, [text]);
  return <article className="markdown-preview">
    <div className="preview-toolbar"><span>Markdown</span><label><input type="checkbox" checked={remote}
      onChange={e => setRemote(e.target.checked)} />{english ? 'Load remote images' : '載入遠端圖片'}</label></div>
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      code: ({ className, children }) => {
        const language = /language-([\w+-]+)/.exec(className ?? '')?.[1];
        return language ? <Highlight text={String(children)} language={language} /> : <code>{children}</code>;
      },
      img: ({ src, alt }) => typeof src === 'string'
        ? <Image src={src} alt={alt} document={document} remote={remote} english={english} /> : null,
      a: ({ href, children }) => <a href={href} onClick={e => {
        e.preventDefault();
        if (href && /^https?:\/\//i.test(href)) void invoke('open_external', { url: href }).catch(e => report(String(e)));
      }}>{children}</a>,
    }}>{rendered}</Markdown>
  </article>;
}
