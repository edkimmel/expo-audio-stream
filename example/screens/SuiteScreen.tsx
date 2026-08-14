import { useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Suite, TestResult, runSuite } from "../testkit/runner";

type Status = "idle" | "running" | "pass" | "fail";

/**
 * Generic runner UI for one test suite. testIDs are the Maestro contract:
 *   run-suite     — the run button
 *   suite-status  — text becomes exactly "PASS" or "FAIL" when finished
 *   back-home     — link back to the suite list
 */
export default function SuiteScreen({
  suite,
  onBack,
}: {
  suite: Suite;
  onBack: () => void;
}) {
  const [results, setResults] = useState<TestResult[]>([]);
  const [status, setStatus] = useState<Status>("idle");

  const run = async () => {
    if (status === "running") return;
    setResults([]);
    setStatus("running");
    const finished = await runSuite(suite, setResults);
    setStatus(finished.every((r) => r.passed) ? "pass" : "fail");
  };

  const statusText =
    status === "pass"
      ? "PASS"
      : status === "fail"
        ? "FAIL"
        : status === "running"
          ? "RUNNING"
          : "READY";

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <TouchableOpacity testID="back-home" onPress={onBack}>
        <Text style={styles.back}>‹ All suites</Text>
      </TouchableOpacity>

      <Text style={styles.title}>{suite.title}</Text>
      <Text style={styles.description}>{suite.description}</Text>

      <TouchableOpacity testID="run-suite" style={styles.runButton} onPress={run}>
        <Text style={styles.runButtonText}>
          {status === "running" ? "Running…" : "Run suite"}
        </Text>
      </TouchableOpacity>

      <View style={styles.statusRow}>
        {status === "running" && <ActivityIndicator />}
        <Text
          testID="suite-status"
          style={[
            styles.statusText,
            status === "pass" && styles.passText,
            status === "fail" && styles.failText,
          ]}
        >
          {statusText}
        </Text>
      </View>

      {suite.tests.map((test, i) => {
        const result = results[i];
        return (
          <View key={test.name} style={styles.testRow}>
            <Text style={styles.testMark}>
              {result ? (result.passed ? "✓" : "✗") : "·"}
            </Text>
            <View style={styles.testBody}>
              <Text style={styles.testName}>{test.name}</Text>
              {result && !result.passed && (
                <Text style={styles.testDetail}>{result.detail}</Text>
              )}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 64 },
  back: { fontSize: 16, color: "#2563eb", marginBottom: 12 },
  title: { fontSize: 24, fontWeight: "700" },
  description: { fontSize: 14, color: "#555", marginTop: 4, marginBottom: 16 },
  runButton: {
    backgroundColor: "#2563eb",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  runButtonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginVertical: 16,
  },
  statusText: { fontSize: 20, fontWeight: "700", color: "#888" },
  passText: { color: "#16a34a" },
  failText: { color: "#dc2626" },
  testRow: { flexDirection: "row", paddingVertical: 6 },
  testMark: { width: 24, fontSize: 16 },
  testBody: { flex: 1 },
  testName: { fontSize: 15 },
  testDetail: { fontSize: 13, color: "#dc2626", marginTop: 2 },
});
