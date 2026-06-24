import Feather from "@expo/vector-icons/Feather";
import React, { useState } from "react";
import {
  Platform,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import colors from "@/constants/colors";
import { useSync } from "@/context/SyncContext";
import { useColors } from "@/hooks/useColors";

export default function QueueScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { queueSummary, queue, syncPending, refreshQueue, removeQueuedTransaction } = useSync();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await syncPending();
    } catch {
      await refreshQueue();
    } finally {
      setRefreshing(false);
    }
  };

  const allClear = queueSummary.total === 0;

  const remove = (clientTransactionId: string) => {
    Alert.alert(
      "Remove queued transaction?",
      "This only removes the copy waiting on this phone. It cannot remove stock already accepted by the desktop.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => void removeQueuedTransaction(clientTransactionId),
        },
      ],
    );
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: c.background }]}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + (Platform.OS === "web" ? 67 : 18),
          paddingBottom: insets.bottom + 90,
        },
      ]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} />
      }
    >
      <Text style={[styles.title, { color: c.foreground }]}>Sync queue</Text>
      <Text style={[styles.description, { color: c.mutedForeground }]}>
        Only transactions that have not reached the desktop are stored here.
        Accepted transactions are removed automatically.
      </Text>

      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        <View style={styles.metric}>
          <Feather name="clock" size={22} color={colors.light.pending} />
          <View>
            <Text style={[styles.metricValue, { color: c.foreground }]}>
              {queueSummary.pending}
            </Text>
            <Text style={[styles.metricLabel, { color: c.mutedForeground }]}>
              Waiting to sync
            </Text>
          </View>
        </View>
        <View style={[styles.divider, { backgroundColor: c.border }]} />
        <View style={styles.metric}>
          <Feather name="alert-triangle" size={22} color={colors.light.stockOut} />
          <View>
            <Text style={[styles.metricValue, { color: c.foreground }]}>
              {queueSummary.rejected}
            </Text>
            <Text style={[styles.metricLabel, { color: c.mutedForeground }]}>
              Rejected and needing desktop review
            </Text>
          </View>
        </View>
      </View>

      {allClear ? (
        <View style={styles.empty}>
          <Feather name="check-circle" size={48} color={colors.light.stockIn} />
          <Text style={[styles.emptyTitle, { color: c.foreground }]}>
            Everything is synchronized
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.queueList}>
            {queue.map((entry) => (
              <View key={entry.clientTransactionId} style={[styles.queueEntry, { backgroundColor: c.card, borderColor: c.border }]}>
                <View style={styles.queueEntryText}>
                  <Text style={[styles.queueEntryTitle, { color: c.foreground }]}>
                    {entry.type === "MATERIAL_OUT" ? "Material Out" : "Return found stock"}
                  </Text>
                  <Text style={[styles.queueEntryMeta, { color: c.mutedForeground }]}>
                    {entry.type === "MATERIAL_OUT" && entry.payload.purpose
                      ? `${String(entry.payload.purpose).replaceAll("_", " ")} · `
                      : ""}
                    {new Date(entry.createdAt).toLocaleString()} · {entry.status === "REJECTED" ? "Rejected" : "Waiting"}
                  </Text>
                  {entry.lastError ? <Text style={styles.queueEntryError}>{entry.lastError}</Text> : null}
                </View>
                <TouchableOpacity
                  accessibilityLabel="Remove queued transaction"
                  style={[styles.removeButton, { backgroundColor: c.muted }]}
                  onPress={() => remove(entry.clientTransactionId)}
                >
                  <Feather name="trash-2" size={17} color={colors.light.stockOut} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: c.primary }]}
            onPress={() => void refresh()}
            disabled={refreshing}
          >
            <Feather name="refresh-cw" size={17} color="#fff" />
            <Text style={styles.buttonText}>Try synchronization now</Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 18 },
  title: { fontSize: 28, fontFamily: "Inter_700Bold", marginBottom: 8 },
  description: { fontSize: 14, lineHeight: 21, marginBottom: 24 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 18 },
  metric: { flexDirection: "row", alignItems: "center", gap: 14 },
  metricValue: { fontSize: 24, fontFamily: "Inter_700Bold" },
  metricLabel: { fontSize: 13, marginTop: 2 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 18 },
  empty: { alignItems: "center", gap: 12, paddingTop: 60 },
  emptyTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold" },
  button: {
    minHeight: 50,
    borderRadius: 14,
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  buttonText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  queueList: { gap: 10, marginTop: 18 },
  queueEntry: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  queueEntryText: { flex: 1, gap: 3 },
  queueEntryTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  queueEntryMeta: { fontSize: 12 },
  queueEntryError: { color: colors.light.stockOut, fontSize: 12, lineHeight: 17, marginTop: 3 },
  removeButton: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
});
