// Standalone tests for TallyStepCleaner (pure Swift, no Xcode test target).
// Run: ios/App/AITests/run.sh
import Foundation

var failures = 0
func expect(_ condition: Bool, _ name: String) {
    if condition { print("ok   \(name)") } else { print("FAIL \(name)"); failures += 1 }
}

// Titles
expect(TallyStepCleaner.cleanTitle("   ") == nil, "blank title rejected")
expect(TallyStepCleaner.cleanTitle("") == nil, "empty title rejected")
expect(TallyStepCleaner.cleanTitle(String(repeating: "a", count: 201)) == nil, "over-long title rejected")
expect(TallyStepCleaner.cleanTitle(String(repeating: "a", count: 200)) != nil, "200-char title accepted")
expect(TallyStepCleaner.cleanTitle("  Build   my\n portfolio ") == "Build my portfolio", "title whitespace collapsed")

// Requests and fragments
expect(TallyStepCleaner.cleanRequest("  ") == nil, "blank request rejected")
expect(TallyStepCleaner.cleanRequest(String(repeating: "a", count: 301)) == nil, "over-long request rejected")
expect(TallyStepCleaner.cleanRequest(String(repeating: "a", count: 300)) != nil, "300-char request accepted")
expect(TallyStepCleaner.cleanRequest(" Call  Marcus\ntomorrow ") == "Call Marcus tomorrow", "request whitespace collapsed")
expect(TallyStepCleaner.cleanFragment("") == "", "empty fragment allowed")
expect(TallyStepCleaner.cleanFragment("  next   Friday ") == "next Friday", "fragment whitespace collapsed")
expect(TallyStepCleaner.cleanFragment(String(repeating: "x", count: 200)).count == TallyStepCleaner.maxFragmentLength, "long fragment shortened")

// Focus facts and summary
expect(TallyStepCleaner.cleanFacts("") == nil, "empty facts rejected")
expect(TallyStepCleaner.cleanFacts(" \n  \n") == nil, "blank-line facts rejected")
expect(TallyStepCleaner.cleanFacts(String(repeating: "a", count: 1501)) == nil, "over-long facts rejected")
expect(TallyStepCleaner.cleanFacts("1.  Call   Mom\n\n2. Water plants") == "1. Call Mom\n2. Water plants", "facts lines collapsed")
expect(TallyStepCleaner.cleanSummary("  \"Start with Call Mom.\"  ") == "Start with Call Mom.", "summary quotes stripped")
expect(TallyStepCleaner.cleanSummary("") == nil, "empty summary rejected")
expect(TallyStepCleaner.cleanSummary(String(repeating: "x", count: 241)) == nil, "over-long summary rejected")
expect(TallyStepCleaner.cleanSummary(String(repeating: "x", count: 240)) != nil, "240-char summary accepted")

// Steps
expect(TallyStepCleaner.cleanSteps(["1. Outline sections", "2) Gather projects", "- Build layout"])
    == ["Outline sections", "Gather projects", "Build layout"], "list markers stripped")
expect(TallyStepCleaner.cleanSteps(["Create a website.", "Wait for it...", "Is it done?", "v2.0 release", "..."])
    == ["Create a website", "Wait for it", "Is it done?", "v2.0 release"], "trailing periods dropped, other punctuation kept")
expect(TallyStepCleaner.cleanSteps(["Test it", "test it", "  TEST IT ", "Ship it"]) == ["Test it", "Ship it"], "duplicates dropped case-insensitively")
expect(TallyStepCleaner.cleanSteps(["", "   ", "Real step"]) == ["Real step"], "empty steps dropped")
expect(TallyStepCleaner.cleanSteps((1...9).map { "Step \($0)" }).count == TallyStepCleaner.maxSteps, "capped at max steps")
expect(TallyStepCleaner.cleanSteps([String(repeating: "x", count: 500)])[0].count == TallyStepCleaner.maxStepLength, "long step shortened")
expect(TallyStepCleaner.cleanSteps(["B", "A", "C"]) == ["B", "A", "C"], "order preserved")
expect(TallyStepCleaner.cleanSteps([]) == [], "empty input")

print(failures == 0 ? "ALL PASSED" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
