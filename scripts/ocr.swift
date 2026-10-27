import Foundation
import AppKit
import Vision
import PDFKit

guard CommandLine.arguments.count > 1 else { exit(0) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
func recognize(_ cgImage: CGImage) -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-IN", "hi-IN"]
    request.minimumTextHeight = 0.006
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try? handler.perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
}
func recognize(_ image: NSImage) -> [String] {
    guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return [] }
    return recognize(cgImage)
}
func recognize(_ page: PDFPage) -> [String] {
    let bounds = page.bounds(for: .mediaBox)
    let scale = max(CGFloat(1), CGFloat(2600) / max(bounds.width, bounds.height))
    let width = max(1, Int((bounds.width * scale).rounded()))
    let height = max(1, Int((bounds.height * scale).rounded()))
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return [] }
    context.setFillColor(NSColor.white.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: context)
    guard let image = context.makeImage() else { return [] }
    return recognize(image)
}
if let pdf = PDFDocument(url: url) {
    let pages = (0..<pdf.pageCount).flatMap { index -> [String] in
        guard let page = pdf.page(at: index) else { return [] }
        // Digitally generated PDFs already expose selectable text. This is more
        // accurate than OCR and avoids losing small text in a thumbnail render.
        if let text = page.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            return text.components(separatedBy: .newlines).filter { !$0.isEmpty }
        }
        return recognize(page)
    }
    print(pages.joined(separator: "\n"))
} else if let image = NSImage(contentsOf: url) {
    print(recognize(image).joined(separator: "\n"))
}
