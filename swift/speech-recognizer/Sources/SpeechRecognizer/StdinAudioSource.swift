import AVFoundation
import Foundation

/// Timestamped audio buffer for the speech analysis pipeline.
struct TimestampedBuffer: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    let hostTime: UInt64
}

/// Reads raw PCM16 LE audio at 16kHz mono from stdin and produces
/// an AsyncStream of TimestampedBuffer for the speech recognizer.
@available(macOS 15.0, *)
final class StdinAudioSource: Sendable {
    /// Audio format: PCM 16-bit signed integer, 16kHz, mono, little-endian (native on Apple Silicon and Intel).
    let format: AVAudioFormat

    let stream: AsyncStream<TimestampedBuffer>
    private let continuation: AsyncStream<TimestampedBuffer>.Continuation

    init() {
        self.format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16000,
            channels: 1,
            interleaved: true
        )!

        var cont: AsyncStream<TimestampedBuffer>.Continuation!
        self.stream = AsyncStream(bufferingPolicy: .bufferingNewest(256)) { cont = $0 }
        self.continuation = cont
    }

    /// Read stdin in a blocking loop on a background thread.
    /// Produces TimestampedBuffer values with timestamps computed from cumulative sample count.
    /// Returns when stdin reaches EOF.
    func start() async {
        let chunkSize = 4096  // bytes per read (2048 samples at 16-bit)
        let bytesPerSample = 2  // 16-bit PCM
        let sampleRate: Double = 16000.0

        await withCheckedContinuation { (outer: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInteractive).async { [self] in
                let stdinHandle = FileHandle.standardInput
                var cumulativeSamples: UInt64 = 0
                // Record a reference host time at start
                let originHostTime = mach_continuous_time()
                var leftoverBytes = Data()

                while true {
                    let data = stdinHandle.readData(ofLength: chunkSize)
                    if data.isEmpty {
                        // EOF
                        break
                    }

                    // Combine any leftover bytes from previous read
                    var combined = leftoverBytes + data
                    leftoverBytes = Data()

                    // Ensure we have an even number of bytes (each sample is 2 bytes)
                    if combined.count % bytesPerSample != 0 {
                        leftoverBytes = combined.suffix(combined.count % bytesPerSample)
                        combined = combined.prefix(combined.count - leftoverBytes.count)
                    }

                    let sampleCount = combined.count / bytesPerSample
                    guard sampleCount > 0 else { continue }

                    let frameCount = AVAudioFrameCount(sampleCount)
                    guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: self.format, frameCapacity: frameCount) else {
                        continue
                    }
                    pcmBuffer.frameLength = frameCount

                    // Copy PCM data into the buffer
                    combined.withUnsafeBytes { rawPtr in
                        if let int16Data = pcmBuffer.int16ChannelData {
                            memcpy(int16Data[0], rawPtr.baseAddress!, combined.count)
                        }
                    }

                    // Compute timestamp from cumulative sample count (not wall clock)
                    let secondsElapsed = Double(cumulativeSamples) / sampleRate
                    let offsetNanos = UInt64(secondsElapsed * 1_000_000_000)
                    let hostTime = originHostTime + offsetNanos

                    let timestamped = TimestampedBuffer(buffer: pcmBuffer, hostTime: hostTime)
                    self.continuation.yield(timestamped)

                    cumulativeSamples += UInt64(sampleCount)
                }

                self.continuation.finish()
                outer.resume()
            }
        }
    }

    func stop() {
        continuation.finish()
    }
}
