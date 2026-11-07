import Foundation
import ApplicationServices
import CoreGraphics

let session = CGSessionCopyCurrentDictionary()
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
let matching = windows?.filter { ($0[kCGWindowOwnerName as String] as? String) == "Free Code Editor" || ($0[kCGWindowOwnerName as String] as? String) == "free-code-editor" }
let report: [String: Any] = [
  "accessibilityTrusted": AXIsProcessTrusted(),
  "screenCaptureAllowed": CGPreflightScreenCaptureAccess(),
  "graphicalSessionAvailable": session != nil,
  "windowListAvailable": windows != nil,
  "editorWindowsVisible": matching?.count ?? 0
]
let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
print(String(data: data, encoding: .utf8)!)
