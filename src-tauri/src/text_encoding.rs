//! Strict, reversible text conversion using OS codecs; no replacement characters or best-fit saves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Big5,
    Gbk,
    Gb18030,
}
impl Encoding {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("utf8").to_ascii_lowercase().as_str() {
            "utf8" | "utf-8" => Ok(Self::Utf8),
            "big5" | "cp950" => Ok(Self::Big5),
            "gbk" | "gb2312" | "cp936" => Ok(Self::Gbk),
            "gb18030" => Ok(Self::Gb18030),
            _ => Err("Unsupported text encoding".into()),
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Utf8 => "utf8",
            Self::Big5 => "big5",
            Self::Gbk => "gbk",
            Self::Gb18030 => "gb18030",
        }
    }
}
pub fn decode(bytes: &[u8], encoding: Encoding) -> Result<String, String> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) || bytes.contains(&0) {
        return Err("Binary and UTF-16/UTF-32 files are not supported".into());
    }
    if encoding == Encoding::Utf8 {
        return String::from_utf8(bytes.to_vec()).map_err(|error| format!("ENCODING_REQUIRED: invalid UTF-8 at byte {} (zero-based). Select Big5/CP950, GBK or GB18030 to reopen this file.", error.utf8_error().valid_up_to()));
    }
    let text = native_decode(bytes, encoding)?;
    // Reject ambiguous byte aliases too: accepted files must survive a no-edit save byte-for-byte.
    if native_encode(&text, encoding)? != bytes {
        return Err(format!(
            "{} cannot round-trip these bytes without changes",
            encoding.label()
        ));
    }
    Ok(text)
}
pub fn encode(text: &str, encoding: Encoding) -> Result<Vec<u8>, String> {
    if text.contains('\0') {
        return Err("NUL characters are not supported in text files".into());
    }
    if encoding == Encoding::Utf8 {
        return Ok(text.as_bytes().to_vec());
    }
    let bytes = native_encode(text, encoding)?;
    if native_decode(&bytes, encoding)? != text {
        return Err(format!(
            "Text cannot be saved losslessly as {}; use UTF-8 or GB18030",
            encoding.label()
        ));
    }
    Ok(bytes)
}
#[cfg(unix)]
mod unix {
    use super::Encoding;
    use std::ffi::{c_char, c_int, c_void, CString};
    #[cfg_attr(target_os = "macos", link(name = "iconv"))]
    unsafe extern "C" {
        fn iconv_open(to: *const c_char, from: *const c_char) -> *mut c_void;
        fn iconv(
            handle: *mut c_void,
            input: *mut *mut c_char,
            input_left: *mut usize,
            output: *mut *mut c_char,
            output_left: *mut usize,
        ) -> usize;
        fn iconv_close(handle: *mut c_void) -> c_int;
    }
    struct Converter(*mut c_void);
    impl Drop for Converter {
        fn drop(&mut self) {
            unsafe {
                iconv_close(self.0);
            }
        }
    }
    pub fn name(encoding: Encoding) -> &'static str {
        match encoding {
            Encoding::Utf8 => "UTF-8",
            Encoding::Big5 => "CP950",
            Encoding::Gbk => "CP936",
            Encoding::Gb18030 => "GB18030",
        }
    }
    pub fn convert(bytes: &[u8], from: &str, to: &str) -> Result<Vec<u8>, String> {
        if bytes.is_empty() {
            return Ok(Vec::new());
        }
        let from_name = CString::new(from).unwrap();
        let to_name = CString::new(to).unwrap();
        let handle = unsafe { iconv_open(to_name.as_ptr(), from_name.as_ptr()) };
        if handle as isize == -1 {
            return Err(format!("System codec {from}/{to} is unavailable"));
        }
        let converter = Converter(handle);
        let mut output = vec![
            0u8;
            bytes
                .len()
                .checked_mul(4)
                .and_then(|n| n.checked_add(16))
                .ok_or("Text is too large")?
        ];
        let mut input = bytes.as_ptr() as *mut c_char;
        let mut input_left = bytes.len();
        let mut target = output.as_mut_ptr().cast();
        let mut output_left = output.len();
        let result = unsafe {
            iconv(
                converter.0,
                &mut input,
                &mut input_left,
                &mut target,
                &mut output_left,
            )
        };
        if result != 0 || input_left != 0 {
            return Err(format!("Invalid or unrepresentable {from}/{to} text at byte {}; conversion would lose data", bytes.len() - input_left));
        }
        output.truncate(output.len() - output_left);
        Ok(output)
    }
}
#[cfg(unix)]
fn native_decode(bytes: &[u8], encoding: Encoding) -> Result<String, String> {
    let convert = |data: &[u8]| -> Result<String, String> {
        String::from_utf8(unix::convert(data, unix::name(encoding), "UTF-8")?)
            .map_err(|e| e.to_string())
    };
    if encoding != Encoding::Gb18030 {
        return convert(bytes);
    }
    // Some system iconv tables omit supplementary GB18030 characters. The linear
    // U+10000..U+10FFFF range starts at pointer 189000 (Encoding Standard).
    let mut result = String::new();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if index + 3 < bytes.len()
            && (0x81..=0xfe).contains(&bytes[index])
            && (0x30..=0x39).contains(&bytes[index + 1])
            && (0x81..=0xfe).contains(&bytes[index + 2])
            && (0x30..=0x39).contains(&bytes[index + 3])
        {
            let pointer = (((u32::from(bytes[index]) - 0x81) * 10 + u32::from(bytes[index + 1])
                - 0x30)
                * 126
                + u32::from(bytes[index + 2])
                - 0x81)
                * 10
                + u32::from(bytes[index + 3])
                - 0x30;
            if pointer >= 189000 {
                let character = char::from_u32(pointer - 189000 + 0x10000)
                    .ok_or("Invalid GB18030 supplementary character")?;
                result.push_str(&convert(&bytes[start..index])?);
                result.push(character);
                index += 4;
                start = index;
                continue;
            }
            index += 4;
        } else {
            index += if bytes[index] >= 0x81 && index + 1 < bytes.len() {
                2
            } else {
                1
            };
        }
    }
    result.push_str(&convert(&bytes[start..])?);
    Ok(result)
}
#[cfg(unix)]
fn native_encode(text: &str, encoding: Encoding) -> Result<Vec<u8>, String> {
    if encoding != Encoding::Gb18030 {
        return unix::convert(text.as_bytes(), "UTF-8", unix::name(encoding));
    }
    let mut bytes = Vec::new();
    let mut start = 0;
    for (index, character) in text.char_indices() {
        if character as u32 >= 0x10000 {
            bytes.extend(unix::convert(
                &text.as_bytes()[start..index],
                "UTF-8",
                "GB18030",
            )?);
            let mut pointer = character as u32 - 0x10000 + 189000;
            let fourth = (pointer % 10) as u8 + 0x30;
            pointer /= 10;
            let third = (pointer % 126) as u8 + 0x81;
            pointer /= 126;
            let second = (pointer % 10) as u8 + 0x30;
            pointer /= 10;
            bytes.extend([pointer as u8 + 0x81, second, third, fourth]);
            start = index + character.len_utf8();
        }
    }
    bytes.extend(unix::convert(
        &text.as_bytes()[start..],
        "UTF-8",
        "GB18030",
    )?);
    Ok(bytes)
}
#[cfg(windows)]
mod windows {
    use super::Encoding;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MultiByteToWideChar(
            page: u32,
            flags: u32,
            input: *const u8,
            count: i32,
            output: *mut u16,
            capacity: i32,
        ) -> i32;
        fn WideCharToMultiByte(
            page: u32,
            flags: u32,
            input: *const u16,
            count: i32,
            output: *mut u8,
            capacity: i32,
            default: *const u8,
            used: *mut i32,
        ) -> i32;
    }
    fn page(encoding: Encoding) -> u32 {
        match encoding {
            Encoding::Utf8 => 65001,
            Encoding::Big5 => 950,
            Encoding::Gbk => 936,
            Encoding::Gb18030 => 54936,
        }
    }
    pub fn decode(bytes: &[u8], encoding: Encoding) -> Result<String, String> {
        if bytes.is_empty() {
            return Ok(String::new());
        }
        let count = i32::try_from(bytes.len()).map_err(|e| e.to_string())?;
        let needed = unsafe {
            MultiByteToWideChar(
                page(encoding),
                8,
                bytes.as_ptr(),
                count,
                std::ptr::null_mut(),
                0,
            )
        };
        if needed == 0 {
            return Err(format!(
                "Invalid {} text: {}",
                encoding.label(),
                std::io::Error::last_os_error()
            ));
        }
        let mut wide = vec![0; needed as usize];
        if unsafe {
            MultiByteToWideChar(
                page(encoding),
                8,
                bytes.as_ptr(),
                count,
                wide.as_mut_ptr(),
                needed,
            )
        } != needed
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        String::from_utf16(&wide).map_err(|e| e.to_string())
    }
    pub fn encode(text: &str, encoding: Encoding) -> Result<Vec<u8>, String> {
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let wide: Vec<_> = text.encode_utf16().collect();
        let count = i32::try_from(wide.len()).map_err(|e| e.to_string())?;
        let mut used = 0;
        let used_ptr = if encoding == Encoding::Gb18030 {
            std::ptr::null_mut()
        } else {
            &mut used
        };
        let flags = if encoding == Encoding::Gb18030 {
            0x80
        } else {
            0x400
        };
        let needed = unsafe {
            WideCharToMultiByte(
                page(encoding),
                flags,
                wide.as_ptr(),
                count,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
                used_ptr,
            )
        };
        if needed == 0 || used != 0 {
            return Err(format!(
                "Text cannot be saved losslessly as {}; use UTF-8 or GB18030",
                encoding.label()
            ));
        }
        let mut output = vec![0; needed as usize];
        let written = unsafe {
            WideCharToMultiByte(
                page(encoding),
                flags,
                wide.as_ptr(),
                count,
                output.as_mut_ptr(),
                needed,
                std::ptr::null(),
                used_ptr,
            )
        };
        if written != needed || used != 0 {
            return Err(format!(
                "Text cannot be saved losslessly as {}",
                encoding.label()
            ));
        }
        Ok(output)
    }
}
#[cfg(windows)]
use windows::{decode as native_decode, encode as native_encode};
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trips_cp950_cp936_and_gb18030_without_replacements() {
        assert_eq!(
            decode(&[0xa4, 0x55, 0xa4, 0xc8], Encoding::Big5).unwrap(),
            "下午"
        );
        assert_eq!(
            encode("下午", Encoding::Big5).unwrap(),
            [0xa4, 0x55, 0xa4, 0xc8]
        );
        assert_eq!(
            decode(&[0xd6, 0xd0, 0xce, 0xc4], Encoding::Gbk).unwrap(),
            "中文"
        );
        for encoding in [Encoding::Big5, Encoding::Gbk, Encoding::Gb18030] {
            let text = "中文\tCRLF\r\n";
            assert_eq!(
                decode(&encode(text, encoding).unwrap(), encoding).unwrap(),
                text
            );
            assert!(decode(&[0x81], encoding).is_err());
            assert_eq!(decode(&[], encoding).unwrap(), "");
        }
        for text in ["\u{10000}", "\u{10ffff}", "前😀後"] {
            assert_eq!(
                decode(&encode(text, Encoding::Gb18030).unwrap(), Encoding::Gb18030).unwrap(),
                text
            );
        }
        assert!(encode("😀", Encoding::Big5).is_err());
        assert!(encode("😀", Encoding::Gbk).is_err());
        assert_eq!(
            decode(
                &encode("简体中文😀", Encoding::Gb18030).unwrap(),
                Encoding::Gb18030
            )
            .unwrap(),
            "简体中文😀"
        );
    }
}
