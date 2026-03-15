# Custom Dictionary / Vocabulary for SpeechTranscriber - Research Findings

**Date:** 2026-03-15
**Status:** Research complete

## Summary

SpeechTranscriber (macOS 26+) does NOT support custom vocabulary or contextual strings. The `contextualStrings` feature is only available via `DictationTranscriber` through the `AnalysisContext` API. There are several possible approaches, each with trade-offs.

## Current Setup

Our speech recognizer at `swift/speech-recognizer/Sources/SpeechRecognizer/main.swift` uses:

```swift
let transcriber = SpeechTranscriber(
    locale: Locale(identifier: "en-US"),
    transcriptionOptions: [],
    reportingOptions: [.volatileResults],
    attributeOptions: []
)
let analyzer = SpeechAnalyzer(modules: [transcriber])
```

Neither our code nor the reference transcriber at `/Users/jtennant/Development/jtennant-transcriber/` uses any custom vocabulary features.

## API Findings

### 1. SpeechTranscriber - No Custom Vocabulary Support

SpeechTranscriber is Apple's new high-quality on-device transcription module (macOS 26 / iOS 26). It uses a new proprietary Apple model and provides excellent general-purpose transcription. However, it **does not support** `contextualStrings` or any custom vocabulary mechanism.

Per Apple's documentation and developer forums: "DictationTranscriber supports contextualStrings by way of `AnalysisContext.contextualStrings` used with `SpeechAnalyzer.context`, however SpeechTranscriber does not support this."

Argmax (WhisperKit maintainers) confirmed: "Apple's new SpeechAnalyzer (iOS 26) API lacks the Custom Vocabulary feature that lets developers improve accuracy on known-and-registered keywords while Apple's older SFSpeechRecognizer API (pre-iOS 26) has this feature and surpasses their new API in accuracy."

### 2. DictationTranscriber - Supports contextualStrings

`DictationTranscriber` is a fallback transcriber module that supports the same languages and devices as iOS 10's on-device `SFSpeechRecognizer`. It supports `contextualStrings` via `AnalysisContext`:

```swift
// Hypothetical usage (based on forum posts, not fully documented yet):
let dictationTranscriber = DictationTranscriber(locale: Locale(identifier: "en-US"))
let analyzer = SpeechAnalyzer(modules: [dictationTranscriber])

let context = AnalysisContext()
// Set contextual strings keyed by tag:
context.contextualStrings = [
    AnalysisContext.ContextualStringsTag("vocabulary"): [
        "Claude", "Kochiku", "voicebites", "reminderkit",
        "SpeechTranscriber", "SpeechAnalyzer"
    ]
]
try await analyzer.setContext(context)
```

**Trade-offs of switching to DictationTranscriber:**
- Lower quality transcription model (older, less accurate for general speech)
- Designed as a fallback for unsupported devices/languages
- Adds punctuation and sentence structure (dictation-style output)
- Does support contextualStrings

### 3. SFSpeechRecognizer (Legacy API) - contextualStrings + Custom Language Models

The legacy `SFSpeechRecognizer` API (available since iOS 10, still works on macOS 26) supports:

**a) contextualStrings (simple approach):**
```swift
let request = SFSpeechAudioBufferRecognitionRequest()
request.contextualStrings = ["Claude", "Kochiku", "voicebites", "reminderkit"]
request.requiresOnDeviceRecognition = true
```
- Array of up to ~100 phrases
- Hints to the recognizer to prioritize these terms
- Simple to implement

**b) SFCustomLanguageModelData (advanced, iOS 17+):**
```swift
let modelData = SFCustomLanguageModelData()
// Add custom pronunciations
let pronunciation = SFCustomLanguageModelData.CustomPronunciation(
    phrase: "Kochiku",
    pronunciation: "ko.tʃi.ku"  // IPA
)
modelData.insert(pronunciation)
// Train and prepare model...
try await SFSpeechLanguageModel.prepareCustomLanguageModel(
    for: modelURL,
    configuration: config
)
```
- More complex setup, requires building a model at development time
- Custom pronunciations with IPA notation
- Template support for generating phrase variations
- Persistent model that can be bundled with the app

**Trade-offs of using SFSpeechRecognizer:**
- Older recognition model (lower quality than SpeechTranscriber)
- Requires managing `SFSpeechRecognizer` lifecycle (authorization, availability checks)
- Different API pattern (callback/delegate based vs async streams)
- Would require significant code rewrite
- On-device recognition may be less accurate than server-based

## Recommended Approaches (Ranked)

### Option A: Post-Processing Text Replacement (Simplest, No API Change)

Instead of changing the speech recognition API, apply text replacements to the transcribed output:

```swift
let corrections: [String: String] = [
    "cloud": "Claude",
    "clod": "Claude",
    "coach iku": "Kochiku",
    "ko chiku": "Kochiku",
    "voice bites": "voicebites",
    "reminder kit": "reminderkit",
]

func applyCorrections(_ text: String) -> String {
    var result = text
    for (wrong, right) in corrections {
        result = result.replacingOccurrences(of: wrong, with: right,
            options: [.caseInsensitive])
    }
    return result
}
```

**Pros:** No API change, works with SpeechTranscriber, easy to maintain, no quality regression
**Cons:** Fragile pattern matching, may cause false positives, doesn't improve actual recognition

### Option B: Switch to DictationTranscriber with contextualStrings

Replace `SpeechTranscriber` with `DictationTranscriber` and use `AnalysisContext.contextualStrings`.

**Pros:** Officially supported API for custom vocabulary, stays within new SpeechAnalyzer framework
**Cons:** Lower quality transcription model, less accurate for general speech, API may still be in flux (beta docs incomplete)

### Option C: Dual-Mode - SpeechTranscriber with SFSpeechRecognizer Fallback

Keep SpeechTranscriber for general transcription, but add an `SFSpeechRecognizer` with `contextualStrings` running in parallel or as a secondary pass.

**Pros:** Best of both worlds - high quality general transcription + custom vocabulary hints
**Cons:** Complex implementation, resource-intensive (two recognizers), potential conflicts

### Option D: Wait for Apple to Add contextualStrings to SpeechTranscriber

SpeechTranscriber is still very new (macOS 26 beta). Apple may add contextualStrings support in a future beta or release.

**Pros:** No work needed now, may get native support
**Cons:** No guarantee it will happen, could be waiting indefinitely

### Option E: Use SFSpeechRecognizer Instead (Full Replacement)

Replace SpeechTranscriber entirely with the legacy SFSpeechRecognizer + contextualStrings.

**Pros:** contextualStrings is well-documented and proven
**Cons:** Older, lower quality model; different API pattern requires significant rewrite; gives up SpeechTranscriber advantages

## Recommendation

**Start with Option A (post-processing)** as it is the simplest and has zero risk of quality regression. Build a configurable corrections dictionary that can be loaded from a config file.

If post-processing proves insufficient, **try Option B (DictationTranscriber)** next, as it stays within the new SpeechAnalyzer framework and the code change is minimal (swap module type, add context).

Monitor Apple's updates for potential contextualStrings support in SpeechTranscriber (Option D).

## Key Sources

- [SpeechTranscriber Documentation](https://developer.apple.com/documentation/speech/speechtranscriber)
- [DictationTranscriber Documentation](https://developer.apple.com/documentation/speech/dictationtranscriber)
- [AnalysisContext Documentation](https://developer.apple.com/documentation/speech/analysiscontext)
- [SFSpeechRecognitionRequest.contextualStrings](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/contextualstrings)
- [WWDC25 Session 277: Bring advanced speech-to-text to your app with SpeechAnalyzer](https://developer.apple.com/videos/play/wwdc2025/277/)
- [Customize on-device speech recognition - WWDC23](https://developer.apple.com/videos/play/wwdc2023/10101/)
- [Apple Developer Forums: Improving Speech Analyzer Transcription](https://developer.apple.com/forums/thread/801877)
- [Argmax: Apple SpeechAnalyzer and WhisperKit Comparison](https://www.argmaxinc.com/blog/apple-and-argmax)
- [SpeechModelBuilder CLI (SFCustomLanguageModelData)](https://github.com/Compiler-Inc/SpeechModelBuilder)
