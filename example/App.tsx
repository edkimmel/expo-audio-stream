import { useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import PlaygroundScreen from "./screens/PlaygroundScreen";
import SuiteScreen from "./screens/SuiteScreen";
import { suites } from "./testkit/suites";

/**
 * Home screen: links to the automated e2e test suites (driven by Maestro in
 * CI — see .maestro/) plus the manual playground. testID contract:
 *   suite-link-<suite id> — opens that suite
 *   playground-link       — opens the manual playground
 */
export default function App() {
  const [route, setRoute] = useState<string>("home");

  if (route === "playground") {
    return (
      <View style={styles.flex}>
        <TouchableOpacity
          testID="back-home"
          style={styles.backBar}
          onPress={() => setRoute("home")}
        >
          <Text style={styles.back}>‹ All suites</Text>
        </TouchableOpacity>
        <PlaygroundScreen />
      </View>
    );
  }

  const suite = suites.find((s) => s.id === route);
  if (suite) {
    return <SuiteScreen suite={suite} onBack={() => setRoute("home")} />;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>expo-audio-stream test suites</Text>
      <Text style={styles.subtitle}>
        Each suite runs on-device against the real native module and reports
        PASS/FAIL. Maestro drives these in CI.
      </Text>

      {suites.map((s) => (
        <TouchableOpacity
          key={s.id}
          testID={`suite-link-${s.id}`}
          style={styles.card}
          onPress={() => setRoute(s.id)}
        >
          <Text style={styles.cardTitle}>{s.title}</Text>
          <Text style={styles.cardDescription}>{s.description}</Text>
        </TouchableOpacity>
      ))}

      <TouchableOpacity
        testID="playground-link"
        style={[styles.card, styles.playgroundCard]}
        onPress={() => setRoute("playground")}
      >
        <Text style={styles.cardTitle}>Manual playground</Text>
        <Text style={styles.cardDescription}>
          Interactive mic/pipeline controls, chaos monkey, drift meter.
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, paddingTop: 64 },
  backBar: { paddingTop: 56, paddingHorizontal: 20 },
  back: { fontSize: 16, color: "#2563eb" },
  title: { fontSize: 26, fontWeight: "700" },
  subtitle: { fontSize: 14, color: "#555", marginTop: 6, marginBottom: 20 },
  card: {
    backgroundColor: "#f3f4f6",
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
  },
  playgroundCard: { backgroundColor: "#eef2ff" },
  cardTitle: { fontSize: 17, fontWeight: "600" },
  cardDescription: { fontSize: 13, color: "#555", marginTop: 4 },
});
