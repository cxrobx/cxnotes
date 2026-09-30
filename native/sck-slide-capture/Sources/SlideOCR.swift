import Foundation
import Vision
import CoreGraphics
import ImageIO

/// Reads the text off captured keyframes, locally.
///
/// Vision ships with the OS, runs on device, needs no model download and no
/// network — which is the only kind of OCR this app can use (invariant #5).
/// The output is fed to the summariser as CONTEXT, never as fact: OCR of a
/// compressed screen capture mangles names and numbers, and a note that
/// asserts a misread figure is worse than one that never saw the slide. The
/// image is kept alongside so the real thing is always one click away.
@available(macOS 13.0, *)
enum SlideOCR {
    struct Result {
        let file: String
        let offsetMs: Int
        let text: String
        let lines: [String]
    }

    /// OCR every keyframe listed in a slides directory's `slides.csv`.
    ///
    /// - Parameter directory: A slides directory written by `SlideCapture`
    /// - Returns: One result per readable keyframe, in capture order
    static func run(directory: String) throws -> [Result] {
        let csvPath = (directory as NSString).appendingPathComponent("slides.csv")
        guard let csv = try? String(contentsOfFile: csvPath, encoding: .utf8) else {
            throw ResolutionFailure(reason: "no slides.csv in \(directory)")
        }

        var results: [Result] = []
        for line in csv.split(separator: "\n").dropFirst() {
            let fields = line.split(separator: ",", maxSplits: 5, omittingEmptySubsequences: false)
            guard fields.count >= 2, let offsetMs = Int(fields[0]) else { continue }
            let file = String(fields[1])
            let imagePath = (directory as NSString).appendingPathComponent(file)
            guard let lines = recogniseText(atPath: imagePath) else { continue }
            results.append(Result(
                file: file,
                offsetMs: offsetMs,
                text: lines.joined(separator: "\n"),
                lines: lines
            ))
        }
        return results
    }

    /// Recognise text in one image, returning its lines top to bottom.
    static func recogniseText(atPath path: String) -> [String]? {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return nil
        }
        return recogniseText(in: image)
    }

    /// Recognise text in an already-decoded frame.
    ///
    /// - Parameter level: `.accurate` for slides, where the text IS the
    ///   content; `.fast` for the live name sampler, which runs every few
    ///   seconds against short labels and must not compete with the capture.
    static func recogniseText(in image: CGImage, level: VNRequestTextRecognitionLevel = .accurate) -> [String]? {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = level
        // Slides are language-heavy and short; correction helps more than it
        // hurts on prose, and the result is context rather than a quotation.
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }

        guard let observations = request.results else { return [] }

        // Vision returns observations in a bottom-left origin space; sorting by
        // descending y then ascending x restores reading order.
        let ordered = observations.sorted { lhs, rhs in
            // 0.01 of frame height: wide enough to treat fragments of one line
            // as the same line, tight enough not to swap adjacent lines.
            if abs(lhs.boundingBox.midY - rhs.boundingBox.midY) > 0.01 {
                return lhs.boundingBox.midY > rhs.boundingBox.midY
            }
            return lhs.boundingBox.minX < rhs.boundingBox.minX
        }

        return ordered.compactMap { $0.topCandidates(1).first?.string }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}
