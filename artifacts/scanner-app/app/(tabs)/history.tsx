import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  RefreshControl,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { useColors } from "@/hooks/useColors";
import { useSync, LocalTransaction } from "@/context/SyncContext";
import colors from "@/constants/colors";

function TransactionItem({ item }: { item: LocalTransaction }) {
  const c = useColors();

  const isIn =
    item.movementType === "Restock" ||
    (item.movementType === "Adjustment" && item.adjustmentDirection !== "out");

  const absQty = Math.abs(item.quantity);
  const date = new Date(item.timestamp);

  const dateStr = date.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
  });

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  const movementLabel =
    item.movementType === "Adjustment"
      ? `Adjustment ${item.adjustmentDirection === "out" ? "Out" : "In"}`
      : item.movementType;

  return (
    <View style={[styles.item, { backgroundColor: c.card, borderColor: c.border }]}>
      <View
        style={[
          styles.typeIndicator,
          {
            backgroundColor: isIn
              ? "rgba(22,163,74,0.12)"
              : "rgba(220,38,38,0.12)",
          },
        ]}
      >
        <Feather
          name={isIn ? "arrow-down-circle" : "arrow-up-circle"}
          size={22}
          color={isIn ? colors.light.stockIn : colors.light.stockOut}
        />
      </View>

      <View style={styles.itemContent}>
        <Text style={[styles.itemName, { color: c.foreground }]} numberOfLines={1}>
          {item.itemName}
        </Text>

        <View style={styles.itemMeta}>
          <Text style={[styles.itemId, { color: c.mutedForeground }]} numberOfLines={1}>
            {item.itemCode}
          </Text>
          <Text style={[styles.itemNote, { color: c.mutedForeground }]} numberOfLines={1}>
            · {movementLabel}
          </Text>
        </View>

        <View style={styles.itemMeta}>
          <Text style={[styles.itemId, { color: c.mutedForeground }]} numberOfLines={1}>
            Ref: {item.refNo}
          </Text>
          <Text style={[styles.itemNote, { color: c.mutedForeground }]} numberOfLines={1}>
            · Used In: {item.usedIn}
          </Text>
        </View>

        <Text style={[styles.itemTime, { color: c.mutedForeground }]}>
          {dateStr} · {timeStr}
        </Text>
      </View>

      <View style={styles.itemRight}>
        <Text
          style={[
            styles.itemQty,
            {
              color: isIn ? colors.light.stockIn : colors.light.stockOut,
            },
          ]}
        >
          {isIn ? "+" : "-"}
          {absQty}
        </Text>

        <View style={styles.syncStatus}>
          {item.synced ? (
            <Feather name="check-circle" size={13} color={colors.light.stockIn} />
          ) : (
            <Feather name="clock" size={13} color={colors.light.pending} />
          )}
          <Text
            style={[
              styles.syncText,
              {
                color: item.synced ? colors.light.stockIn : colors.light.pending,
              },
            ]}
          >
            {item.synced ? "Synced" : "Pending"}
          </Text>
        </View>
      </View>
    </View>
  );
}

export default function HistoryScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { transactions, pendingCount, syncPending, clearHistory } = useSync();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await syncPending();
    setRefreshing(false);
  };

  const handleClear = () => {
    Alert.alert(
      "Clear History",
      "This removes local history only. Transactions already synced to the server are not affected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: clearHistory,
        },
      ]
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + (Platform.OS === "web" ? 67 : 16),
            backgroundColor: c.background,
            borderBottomColor: c.border,
          },
        ]}
      >
        <Text style={[styles.headerTitle, { color: c.foreground }]}>History</Text>

        <View style={styles.headerRight}>
          {pendingCount > 0 && (
            <TouchableOpacity
              style={[styles.syncBtn, { backgroundColor: "#FEF3C7" }]}
              onPress={syncPending}
            >
              <Feather name="refresh-cw" size={14} color={colors.light.pending} />
              <Text style={[styles.syncBtnText, { color: colors.light.pending }]}>
                Sync {pendingCount}
              </Text>
            </TouchableOpacity>
          )}

          {transactions.length > 0 && (
            <TouchableOpacity onPress={handleClear} style={styles.clearBtn}>
              <Feather name="trash-2" size={18} color={c.mutedForeground} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={transactions}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <TransactionItem item={item} />}
        contentContainerStyle={[
          styles.listContent,
          {
            paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 80),
          },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={c.primary}
          />
        }
        scrollEnabled={transactions.length > 0}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Feather name="inbox" size={48} color={c.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: c.foreground }]}>
              No transactions yet
            </Text>
            <Text style={[styles.emptyText, { color: c.mutedForeground }]}>
              Scan a QR code to log your first transaction
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
  },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  syncBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  syncBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  clearBtn: { padding: 4 },
  listContent: { paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  typeIndicator: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  itemContent: { flex: 1, gap: 2 },
  itemName: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  itemMeta: { flexDirection: "row", alignItems: "center" },
  itemId: { fontSize: 12, fontFamily: "Inter_400Regular" },
  itemNote: { fontSize: 12, fontFamily: "Inter_400Regular", flex: 1 },
  itemTime: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  itemRight: { alignItems: "flex-end", gap: 4 },
  itemQty: { fontSize: 18, fontFamily: "Inter_700Bold" },
  syncStatus: { flexDirection: "row", alignItems: "center", gap: 3 },
  syncText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 120,
    gap: 12,
    paddingHorizontal: 32,
  },
  emptyTitle: { fontSize: 18, fontFamily: "Inter_600SemiBold" },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
});
