import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { useColors } from "@/hooks/useColors";
import { useSync } from "@/context/SyncContext";
import colors from "@/constants/colors";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const c = useColors();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: c.mutedForeground }]}>
        {title}
      </Text>
      <View style={[styles.sectionContent, { backgroundColor: c.card, borderColor: c.border }]}>
        {children}
      </View>
    </View>
  );
}

function Row({
  icon,
  label,
  value,
  accent,
}: {
  icon: string;
  label: string;
  value?: string;
  accent?: string;
}) {
  const c = useColors();
  return (
    <View style={[styles.row, { borderBottomColor: c.border }]}>
      <Feather name={icon as any} size={16} color={c.mutedForeground} style={styles.rowIcon} />
      <Text style={[styles.rowLabel, { color: c.foreground }]}>{label}</Text>
      {value !== undefined && (
        <Text style={[styles.rowValue, { color: accent ?? c.mutedForeground }]}>
          {value}
        </Text>
      )}
    </View>
  );
}

export default function SettingsScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { serverUrl, setServerUrl, pendingCount, syncPending, transactions, testConnection } =
    useSync();

  const [urlDraft, setUrlDraft] = useState(serverUrl);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);

  const handleSave = async () => {
    const trimmed = urlDraft.trim().replace(/\/$/, "");
    if (!trimmed) {
      Alert.alert("Invalid URL", "Please enter a valid server URL.");
      return;
    }
    setIsSaving(true);
    await setServerUrl(trimmed);
    setUrlDraft(trimmed);
    setIsSaving(false);
    setTestResult(null);
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    const ok = await testConnection();
    setTestResult(ok ? "ok" : "fail");
    setIsTesting(false);
    if (Platform.OS !== "web") {
      if (ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const handleSync = async () => {
    if (pendingCount === 0) {
      Alert.alert("Nothing to sync", "All transactions are already synced.");
      return;
    }
    await syncPending();
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const syncedCount = transactions.filter((t) => t.synced).length;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: c.background }]}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + (Platform.OS === "web" ? 67 : 16),
          paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 100),
        },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.title, { color: c.foreground }]}>Settings</Text>

      {/* Server URL */}
      <Section title="SERVER CONNECTION">
        <View style={styles.urlInputWrapper}>
          <Feather name="server" size={16} color={c.mutedForeground} style={styles.urlIcon} />
          <TextInput
            style={[styles.urlInput, { color: c.foreground }]}
            value={urlDraft}
            onChangeText={(v) => {
              setUrlDraft(v);
              setTestResult(null);
            }}
            placeholder="http://192.168.1.x:5000"
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            onSubmitEditing={handleSave}
          />
          {urlDraft !== serverUrl && (
            <TouchableOpacity onPress={() => setUrlDraft(serverUrl)}>
              <Feather name="x-circle" size={16} color={c.mutedForeground} />
            </TouchableOpacity>
          )}
        </View>

        <View style={[styles.divider, { backgroundColor: c.border }]} />

        <View style={styles.btnRow}>
          <TouchableOpacity
            style={[
              styles.btn,
              { backgroundColor: c.muted, flex: 1 },
            ]}
            onPress={handleTest}
            disabled={isTesting || !urlDraft.trim()}
          >
            {isTesting ? (
              <ActivityIndicator size="small" color={c.mutedForeground} />
            ) : (
              <>
                <Feather
                  name={
                    testResult === "ok"
                      ? "check-circle"
                      : testResult === "fail"
                      ? "x-circle"
                      : "wifi"
                  }
                  size={15}
                  color={
                    testResult === "ok"
                      ? colors.light.stockIn
                      : testResult === "fail"
                      ? colors.light.stockOut
                      : c.mutedForeground
                  }
                />
                <Text
                  style={[
                    styles.btnText,
                    {
                      color:
                        testResult === "ok"
                          ? colors.light.stockIn
                          : testResult === "fail"
                          ? colors.light.stockOut
                          : c.mutedForeground,
                    },
                  ]}
                >
                  {testResult === "ok"
                    ? "Connected"
                    : testResult === "fail"
                    ? "Failed"
                    : "Test"}
                </Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.btn,
              {
                backgroundColor:
                  urlDraft.trim() && urlDraft !== serverUrl
                    ? c.primary
                    : c.muted,
                flex: 1,
              },
            ]}
            onPress={handleSave}
            disabled={isSaving || !urlDraft.trim() || urlDraft === serverUrl}
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Feather
                  name="save"
                  size={15}
                  color={
                    urlDraft.trim() && urlDraft !== serverUrl
                      ? "#fff"
                      : c.mutedForeground
                  }
                />
                <Text
                  style={[
                    styles.btnText,
                    {
                      color:
                        urlDraft.trim() && urlDraft !== serverUrl
                          ? "#fff"
                          : c.mutedForeground,
                    },
                  ]}
                >
                  Save
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </Section>

      {/* Instructions */}
      <Section title="HOW TO USE">
        <View style={styles.instructionsList}>
          {[
            { icon: "monitor", text: "Run the server on your laptop" },
            { icon: "wifi", text: "Ensure phone and laptop are on the same Wi-Fi network" },
            { icon: "info", text: 'Enter your laptop\'s local IP (e.g. http://192.168.1.10:5000)' },
            { icon: "file-text", text: "Transactions are saved to stock_transactions.xlsx on your laptop" },
          ].map((item, i) => (
            <View key={i} style={[styles.instructionRow, { borderBottomColor: c.border, borderBottomWidth: i < 3 ? StyleSheet.hairlineWidth : 0 }]}>
              <View style={[styles.instructionIcon, { backgroundColor: c.muted }]}>
                <Feather name={item.icon as any} size={14} color={c.mutedForeground} />
              </View>
              <Text style={[styles.instructionText, { color: c.foreground }]}>
                {item.text}
              </Text>
            </View>
          ))}
        </View>
      </Section>

      {/* Sync status */}
      <Section title="SYNC STATUS">
        <Row icon="check-circle" label="Synced" value={`${syncedCount}`} accent={colors.light.stockIn} />
        <Row icon="clock" label="Pending" value={`${pendingCount}`} accent={pendingCount > 0 ? colors.light.pending : c.mutedForeground} />
        <Row icon="list" label="Total" value={`${transactions.length}`} />
        <View style={[styles.divider, { backgroundColor: c.border }]} />
        <TouchableOpacity
          style={[styles.syncAllBtn, { borderColor: colors.light.pending }]}
          onPress={handleSync}
          disabled={pendingCount === 0}
        >
          <Feather name="refresh-cw" size={15} color={pendingCount > 0 ? colors.light.pending : c.mutedForeground} />
          <Text style={[styles.syncAllText, { color: pendingCount > 0 ? colors.light.pending : c.mutedForeground }]}>
            Sync {pendingCount} Pending {pendingCount === 1 ? "Transaction" : "Transactions"}
          </Text>
        </TouchableOpacity>
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 16 },
  title: { fontSize: 28, fontFamily: "Inter_700Bold", marginBottom: 28 },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 4,
  },
  sectionContent: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  urlInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  urlIcon: { flexShrink: 0 },
  urlInput: { flex: 1, fontSize: 15, fontFamily: "Inter_400Regular" },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 14 },
  btnRow: { flexDirection: "row", gap: 10, padding: 12 },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  btnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  rowIcon: { width: 20 },
  rowLabel: { flex: 1, fontSize: 15, fontFamily: "Inter_400Regular" },
  rowValue: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  syncAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    marginHorizontal: 12,
    marginBottom: 4,
    marginTop: 4,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  syncAllText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  instructionsList: {},
  instructionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  instructionIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  instructionText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
});
