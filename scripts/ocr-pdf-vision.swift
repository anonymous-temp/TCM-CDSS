#!/usr/bin/env swift

import AppKit
import Foundation
import PDFKit
import Vision

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: ocr-pdf-vision.swift <input.pdf> <output.txt>\n".utf8))
    exit(2)
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let document = PDFDocument(url: inputURL) else {
    FileHandle.standardError.write(Data("cannot open PDF: \(inputURL.path)\n".utf8))
    exit(2)
}

var output = ""
for pageIndex in 0..<document.pageCount {
    autoreleasepool {
        guard let page = document.page(at: pageIndex) else { return }
        let bounds = page.bounds(for: .mediaBox)
        let scale: CGFloat = 2.0
        let width = Int(bounds.width * scale)
        let height = Int(bounds.height * scale)
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else { return }
        context.setFillColor(NSColor.white.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.saveGState()
        context.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: context)
        context.restoreGState()
        guard let image = context.makeImage() else { return }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            FileHandle.standardError.write(Data("OCR page \(pageIndex + 1) failed: \(error)\n".utf8))
            return
        }
        let observations = (request.results ?? []).sorted { left, right in
            let verticalDelta = left.boundingBox.midY - right.boundingBox.midY
            if abs(verticalDelta) > 0.008 { return verticalDelta > 0 }
            return left.boundingBox.minX < right.boundingBox.minX
        }
        output += "\n=== PAGE \(pageIndex + 1) ===\n"
        output += observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        output += "\n"
        if (pageIndex + 1) % 10 == 0 || pageIndex + 1 == document.pageCount {
            FileHandle.standardError.write(Data("OCR \(pageIndex + 1)/\(document.pageCount)\n".utf8))
        }
    }
}

do {
    try output.write(to: outputURL, atomically: true, encoding: .utf8)
} catch {
    FileHandle.standardError.write(Data("cannot write OCR output: \(error)\n".utf8))
    exit(2)
}
