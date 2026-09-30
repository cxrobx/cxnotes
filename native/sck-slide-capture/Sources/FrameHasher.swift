import Foundation
import CoreImage
import CoreGraphics
import CoreVideo

/// Perceptual hashing and comparison for captured frames.
///
/// Frames arrive continuously; almost none of them are worth keeping. The job
/// here is to answer two questions cheaply: "is this the same picture as the one
/// before it" (stability) and "is this a different picture from the last one we
/// kept" (change). Both are answered on a 9x8 greyscale reduction, so the cost
/// does not scale with display resolution.
enum FrameHasher {
    /// Width of the reduction. One wider than the hash so each row yields 8
    /// adjacent-pixel comparisons.
    static let sampleWidth = 9

    /// Height of the reduction, and therefore the number of hash rows.
    static let sampleHeight = 8

    private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    /// Reduce a frame to a detached image plus a 64-bit difference hash.
    ///
    /// The CGImage is rendered here and handed back deliberately: a
    /// `CVPixelBuffer` is only valid for the life of the ScreenCaptureKit
    /// callback, and the decision to KEEP a frame is made later, once the
    /// picture has held still. Rendering once and carrying the result costs one
    /// copy; going back for the buffer afterwards is a use-after-free.
    ///
    /// dHash rather than average-hash: it keys on local gradients, so it does
    /// not shift wholesale when a projector-bright slide is followed by a dark
    /// one, and it is stable under the compression artefacts of a video call.
    ///
    /// - Parameter pixelBuffer: The frame delivered by ScreenCaptureKit
    /// - Returns: The detached image, its hash, and mean luminance
    static func reduce(_ pixelBuffer: CVPixelBuffer) -> (image: CGImage, hash: UInt64, meanLuminance: Double)? {
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(image, from: image.extent) else {
            return nil
        }

        let width = sampleWidth
        let height = sampleHeight
        var pixels = [UInt8](repeating: 0, count: width * height)

        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else {
            return nil
        }

        context.interpolationQuality = .medium
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        var bits: UInt64 = 0
        var bit = 0
        for row in 0..<height {
            for column in 0..<(width - 1) {
                let left = pixels[row * width + column]
                let right = pixels[row * width + column + 1]
                if left > right {
                    bits |= (1 << UInt64(bit))
                }
                bit += 1
            }
        }

        let total = pixels.reduce(0) { $0 + Int($1) }
        let mean = Double(total) / Double(pixels.count) / 255.0

        return (cgImage, bits, mean)
    }

    /// Number of differing bits between two hashes, 0...64.
    static func distance(_ a: UInt64, _ b: UInt64) -> Int {
        (a ^ b).nonzeroBitCount
    }
}
