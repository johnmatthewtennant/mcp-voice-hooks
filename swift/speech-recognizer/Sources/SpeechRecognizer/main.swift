import AVFoundation
import Foundation
import Speech

// MARK: - JSON Output

/// Serializes stdout writes to avoid concurrent output corruption.
private let outputLock = NSLock()

private func writeJSON(_ dict: [String: String]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
          let line = String(data: data, encoding: .utf8) else {
        return
    }
    outputLock.lock()
    print(line)
    fflush(stdout)
    outputLock.unlock()
}

// MARK: - Analyzer Input Stream

/// Creates an AsyncSequence of AnalyzerInput from timestamped audio buffers,
/// converting format if needed via AVAudioConverter.
@available(macOS 26.0, *)
func makeAnalyzerInputStream(
    from stream: AsyncStream<TimestampedBuffer>,
    targetFormat: AVAudioFormat
) -> AsyncStream<AnalyzerInput> {
    AsyncStream { continuation in
        Task {
            var converter: AVAudioConverter?

            for await timestamped in stream {
                let sourceFormat = timestamped.buffer.format

                // Initialize converter on first buffer if formats differ
                if converter == nil && sourceFormat != targetFormat {
                    converter = AVAudioConverter(from: sourceFormat, to: targetFormat)
                    if converter == nil {
                        fputs("[speech-recognizer] ERROR: AVAudioConverter creation failed for \(sourceFormat) -> \(targetFormat)\n", stderr)
                    }
                }

                let outputBuffer: AVAudioPCMBuffer
                if let converter {
                    let frameCapacity = AVAudioFrameCount(
                        Double(timestamped.buffer.frameLength) * targetFormat.sampleRate / sourceFormat.sampleRate
                    )
                    guard frameCapacity > 0,
                          let convertedBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: frameCapacity) else {
                        continue
                    }

                    var error: NSError?
                    nonisolated(unsafe) var consumed = false
                    converter.convert(to: convertedBuffer, error: &error) { _, outStatus in
                        if !consumed {
                            consumed = true
                            outStatus.pointee = .haveData
                            return timestamped.buffer
                        }
                        outStatus.pointee = .noDataNow
                        return nil
                    }

                    if error != nil || convertedBuffer.frameLength == 0 {
                        continue
                    }
                    outputBuffer = convertedBuffer
                } else {
                    outputBuffer = timestamped.buffer
                }

                let input = AnalyzerInput(buffer: outputBuffer)
                continuation.yield(input)
            }

            continuation.finish()
        }
    }
}

// MARK: - Main

@available(macOS 26.0, *)
func runSpeechRecognizer() async throws {
    fputs("[speech-recognizer] Starting...\n", stderr)

    // Set up stdin audio source (PCM16 LE, 16kHz, mono)
    let audioSource = StdinAudioSource()

    // Create transcriber with volatile results for interim output
    let transcriber = SpeechTranscriber(
        locale: Locale(identifier: "en-US"),
        transcriptionOptions: [],
        reportingOptions: [.volatileResults],
        attributeOptions: []
    )

    // Get the best available audio format for the transcriber
    guard let targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        fputs("[speech-recognizer] ERROR: No compatible audio format available. The speech model may not be installed.\n", stderr)
        fputs("[speech-recognizer] Try using Dictation in System Settings first to trigger model download.\n", stderr)
        exit(1)
    }

    fputs("[speech-recognizer] Target format: \(targetFormat)\n", stderr)

    // Create analyzer and input stream
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let inputStream = makeAnalyzerInputStream(from: audioSource.stream, targetFormat: targetFormat)

    // Run everything concurrently
    await withTaskGroup(of: Void.self) { group in
        // Feed audio from stdin
        group.addTask {
            fputs("[speech-recognizer] Reading from stdin...\n", stderr)
            await audioSource.start()
            fputs("[speech-recognizer] Stdin EOF reached.\n", stderr)
        }

        // Run the analyzer
        group.addTask {
            fputs("[speech-recognizer] Starting analyzer...\n", stderr)
            try? await analyzer.start(inputSequence: inputStream)
            fputs("[speech-recognizer] Analyzer finished.\n", stderr)
        }

        // Process transcription results
        group.addTask {
            fputs("[speech-recognizer] Waiting for results...\n", stderr)
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }

                    if result.isFinal {
                        writeJSON(["type": "final", "text": text])
                    } else {
                        writeJSON(["type": "interim", "text": text])
                    }
                }
            } catch {
                fputs("[speech-recognizer] Transcription error: \(error.localizedDescription)\n", stderr)
            }
            fputs("[speech-recognizer] Results stream ended.\n", stderr)
        }

        await group.waitForAll()
    }

    fputs("[speech-recognizer] Done.\n", stderr)
}

// Entry point with availability check
if #available(macOS 26.0, *) {
    try await runSpeechRecognizer()
} else {
    fputs("[speech-recognizer] ERROR: macOS 26.0 or later is required for SpeechTranscriber API.\n", stderr)
    exit(1)
}
