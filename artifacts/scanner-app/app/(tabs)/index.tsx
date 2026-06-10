import React, { useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  TextInput,
  ActivityIndicator,
  Platform,
  Vibration,
  KeyboardAvoidingView,
  ScrollView,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Feather } from "@expo/vector-icons";

import { useColors } from "@/hooks/useColors";
import { useSync } from "@/context/SyncContext";
import colors from "@/constants/colors";

const DEBOUNCE_MS = 2000;

type MovementType = "Restock" | "Use" | "Adjustment";
type AdjustmentDirection = "in" | "out";

interface ScannedItem {
  qrData: string;
  refNo: string;
  itemCode: string;
  itemName: string;
  unitRate: string;
  godown: string;
  batchNo: string;
}

const REQUIRED_QR_FIELDS: Array<keyof Omit<ScannedItem, "qrData">> = [
  "refNo",
  "itemCode",
  "itemName",
  "unitRate",
  "godown",
  "batchNo",
];

function parseQR(raw: string): ScannedItem {
  const obj = JSON.parse(raw);

  return {
    qrData: raw,
    refNo: String(obj.refNo ?? obj.ref_no ?? ""),
    itemCode: String(obj.itemCode ?? obj.item_code ?? ""),
    itemName: String(obj.itemName ?? obj.item_name ?? ""),
    unitRate: String(obj.unitRate ?? obj.unit_rate ?? ""),
    godown: String(obj.godown ?? ""),
    batchNo: String(obj.batchNo ?? obj.batch_no ?? ""),
  };
}

function getMissingQrFields(item: ScannedItem | null): string[] {
  if (!item) return [];

  const missing = REQUIRED_QR_FIELDS.filter((field) => !String(item[field]).trim()).map(
    (field) => {
      switch (field) {
        case "refNo":
          return "Ref No";
        case "itemCode":
          return "Item Code";
        case "itemName":
          return "Item Name";
        case "unitRate":
          return "Unit";
        case "godown":
          return "Godown";
        case "batchNo":
          return "Batch No";
        default:
          return field;
      }
    }
  );

  return missing;
}

function getMovementColor(type: MovementType) {
  if (type === "Restock") return colors.light.stockIn;
  if (type === "Use") return colors.light.stockOut;
  return colors.light.primary;
}

export default function ScannerScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { addTransaction, isSubmitting, serverUrl } = useSync();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [product, setProduct] = useState<ScannedItem | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [quantity, setQuantity] = useState("1");
  const [feedback, setFeedback] = useState<"success" | "error" | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [movementType, setMovementType] = useState<MovementType>("Restock");
  const [adjustmentDirection, setAdjustmentDirection] = useState<AdjustmentDirection>("in");
  const [usedIn, setUsedIn] = useState("");
  const lastScanTime = useRef<number>(0);

  const handleBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      const now = Date.now();
      if (now - lastScanTime.current < DEBOUNCE_MS) return;
      lastScanTime.current = now;

      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      try {
        const item = parseQR(data);

        setScanned(true);
        setProduct(item);
        setQuantity("1");
        setFeedback(null);
        setQrError(null);
        setModalVisible(true);
        setMovementType("Restock");
        setAdjustmentDirection("in");
        setUsedIn("");
      } catch (error) {
        console.log("Invalid QR code:", data, error);
        setScanned(true);
        setProduct(null);
        setFeedback(null);
        setQrError("Invalid QR code. Please scan a JSON QR code with Ref No, Item Code, Item Name, Unit, Godown, and Batch No.");
        setModalVisible(true);
        if (Platform.OS !== "web") Vibration.vibrate(200);
      }
    },
    []
  );

  const resetScanner = () => {
    setScanned(false);
    setModalVisible(false);
    setProduct(null);
    setFeedback(null);
    setQrError(null);
  };

  const submitTransaction = async () => {
    if (!product) return;

    const qty = parseFloat(quantity);
    const missingQrFields = getMissingQrFields(product);

    if (isNaN(qty) || qty <= 0 || !usedIn.trim() || missingQrFields.length > 0) {
      setFeedback("error");
      if (Platform.OS !== "web") Vibration.vibrate(200);
      return;
    }

    const ok = await addTransaction({
      refNo: product.refNo,
      movementType,
      itemCode: product.itemCode,
      itemName: product.itemName,
      quantity: qty,
      unitRate: product.unitRate,
      godown: product.godown,
      batchNo: product.batchNo,
      usedIn: usedIn.trim(),
      adjustmentDirection: movementType === "Adjustment" ? adjustmentDirection : undefined,
      timestamp: new Date().toISOString(),
    });

    setFeedback(ok ? "success" : "error");
    if (Platform.OS !== "web") {
      if (ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        Vibration.vibrate(200);
      }
    }

    setTimeout(() => {
      resetScanner();
    }, 1200);
  };

  const adjustQuantity = (delta: number) => {
    const current = parseFloat(quantity) || 0;
    const next = Math.max(1, current + delta);
    setQuantity(String(next));
  };

  const missingQrFields = getMissingQrFields(product);
  const qty = parseFloat(quantity);
  const quantityIsValid = !isNaN(qty) && qty > 0;
  const canSubmit = Boolean(
    product && quantityIsValid && usedIn.trim() && missingQrFields.length === 0 && !isSubmitting
  );

  if (!permission) {
    return <View style={[styles.container, { backgroundColor: c.background }]} />;
  }

  if (!permission.granted) {
    return (
      <View
        style={[
          styles.permissionContainer,
          { backgroundColor: c.background, paddingTop: insets.top + 20 },
        ]}
      >
        <Feather name="camera-off" size={56} color={c.mutedForeground} />
        <Text style={[styles.permissionTitle, { color: c.foreground }]}>Camera Access Required</Text>
        <Text style={[styles.permissionText, { color: c.mutedForeground }]}>Allow camera access to scan QR codes</Text>
        <TouchableOpacity style={[styles.permissionBtn, { backgroundColor: c.primary }]} onPress={requestPermission}>
          <Text style={[styles.permissionBtnText, { color: c.primaryForeground }]}>Allow Camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {Platform.OS !== "web" ? (
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
        />
      ) : (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: "#111827", alignItems: "center", justifyContent: "center" },
          ]}
        >
          <Feather name="camera" size={48} color="#374151" />
          <Text style={{ color: "#6B7280", marginTop: 12, fontSize: 14 }}>Camera preview not available on web</Text>
          <TouchableOpacity
            style={[styles.webScanBtn, { borderColor: colors.light.primary }]}
            onPress={() =>
              handleBarcodeScanned({
                data: JSON.stringify({
                  refNo: "REF-TEST-001",
                  itemCode: "ITEM-001",
                  itemName: "Cotton Roll",
                  unitRate: "pcs",
                  godown: "Store Room A",
                  batchNo: "BATCH-001",
                }),
              })
            }
          >
            <Text style={{ color: colors.light.primary, fontWeight: "600" }}>Simulate Scan</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Top status bar */}
      <View
        style={[
          styles.topBar,
          {
            paddingTop: insets.top + 12,
            backgroundColor: "rgba(0,0,0,0.55)",
          },
        ]}
      >
        <View style={styles.topBarContent}>
          <Text style={styles.topBarTitle}>Stock Scanner</Text>
          <View
            style={[
              styles.serverBadge,
              { backgroundColor: serverUrl ? "rgba(22,163,74,0.8)" : "rgba(220,38,38,0.8)" },
            ]}
          >
            <View style={[styles.serverDot, { backgroundColor: serverUrl ? "#86efac" : "#fca5a5" }]} />
            <Text style={styles.serverBadgeText}>{serverUrl ? "Connected" : "No server"}</Text>
          </View>
        </View>
      </View>

      {/* Scan frame */}
      <View style={styles.overlay}>
        <View style={styles.scanFrame}>
          <View style={[styles.corner, styles.cornerTL]} />
          <View style={[styles.corner, styles.cornerTR]} />
          <View style={[styles.corner, styles.cornerBL]} />
          <View style={[styles.corner, styles.cornerBR]} />
          {!scanned && <Text style={styles.scanHint}>Align QR code within frame</Text>}
        </View>
      </View>

      {/* Transaction Modal */}
      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={resetScanner}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={resetScanner} />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalWrapper}>
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: c.card,
                paddingBottom: insets.bottom + 16,
              },
            ]}
          >
            {feedback ? (
              <View style={styles.feedbackContainer}>
                <Feather
                  name={feedback === "success" ? "check-circle" : "alert-triangle"}
                  size={52}
                  color={feedback === "success" ? colors.light.stockIn : colors.light.pending}
                />
                <Text
                  style={[
                    styles.feedbackText,
                    {
                      color: feedback === "success" ? colors.light.stockIn : colors.light.pending,
                    },
                  ]}
                >
                  {feedback === "success"
                    ? "Saved!"
                    : product
                    ? "Could not save. Check required fields or server connection."
                    : "Invalid QR code."}
                </Text>
              </View>
            ) : qrError ? (
              <View style={styles.feedbackContainer}>
                <Feather name="alert-triangle" size={52} color={colors.light.pending} />
                <Text style={[styles.feedbackText, { color: colors.light.pending }]}>{qrError}</Text>
                <TouchableOpacity style={[styles.permissionBtn, { backgroundColor: c.primary }]} onPress={resetScanner}>
                  <Text style={[styles.permissionBtnText, { color: c.primaryForeground }]}>Scan Again</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                {/* Handle */}
                <View style={styles.sheetHandle} />

                {/* Item */}
                <View style={styles.sheetHeader}>
                  <View style={[styles.productIcon, { backgroundColor: c.muted }]}>
                    <Feather name="package" size={24} color={c.mutedForeground} />
                  </View>
                  <View style={styles.productInfo}>
                    <Text style={[styles.productName, { color: c.foreground }]}>{product?.itemName ?? ""}</Text>
                    <Text style={[styles.productId, { color: c.mutedForeground }]}>{product?.itemCode ?? ""}</Text>
                  </View>
                  <TouchableOpacity onPress={resetScanner} style={styles.closeBtn}>
                    <Feather name="x" size={20} color={c.mutedForeground} />
                  </TouchableOpacity>
                </View>

                {/* QR Details */}
                <View style={styles.section}>
                  <Text style={[styles.label, { color: c.mutedForeground }]}>SCANNED DETAILS</Text>
                  <View style={[styles.detailCard, { backgroundColor: c.background, borderColor: c.border }]}> 
                    <View style={styles.detailRow}>
                      <Text style={[styles.detailLabel, { color: c.mutedForeground }]}>Ref No</Text>
                      <Text style={[styles.detailValue, { color: c.foreground }]}>{product?.refNo || "—"}</Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={[styles.detailLabel, { color: c.mutedForeground }]}>Unit Rate</Text>
                      <Text style={[styles.detailValue, { color: c.foreground }]}>{product?.unitRate || "—"}</Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={[styles.detailLabel, { color: c.mutedForeground }]}>Godown</Text>
                      <Text style={[styles.detailValue, { color: c.foreground }]}>{product?.godown || "—"}</Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={[styles.detailLabel, { color: c.mutedForeground }]}>Batch No</Text>
                      <Text style={[styles.detailValue, { color: c.foreground }]}>{product?.batchNo || "—"}</Text>
                    </View>
                  </View>

                  {missingQrFields.length > 0 && (
                    <Text style={[styles.errorText, { color: colors.light.stockOut }]}>Missing from QR: {missingQrFields.join(", ")}</Text>
                  )}
                </View>

                {/* Movement Type */}
                <View style={styles.section}>
                  <Text style={[styles.label, { color: c.mutedForeground }]}>MOVEMENT TYPE</Text>
                  <View style={styles.actionRow}>
                    {(["Restock", "Use", "Adjustment"] as MovementType[]).map((type) => {
                      const selected = movementType === type;
                      const movementColor = getMovementColor(type);

                      return (
                        <TouchableOpacity
                          key={type}
                          style={[
                            styles.choiceBtn,
                            {
                              backgroundColor: selected ? movementColor : c.background,
                              borderColor: selected ? movementColor : c.border,
                            },
                          ]}
                          onPress={() => setMovementType(type)}
                        >
                          <Text style={[styles.choiceBtnText, { color: selected ? "#fff" : c.foreground }]}>{type}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>

                {/* Adjustment Direction */}
                {movementType === "Adjustment" && (
                  <View style={styles.section}>
                    <Text style={[styles.label, { color: c.mutedForeground }]}>ADJUSTMENT DIRECTION</Text>
                    <View style={styles.actionRow}>
                      {(["in", "out"] as AdjustmentDirection[]).map((direction) => {
                        const selected = adjustmentDirection === direction;
                        const label = direction === "in" ? "In" : "Out";
                        const icon = direction === "in" ? "plus-circle" : "minus-circle";

                        return (
                          <TouchableOpacity
                            key={direction}
                            style={[
                              styles.choiceBtn,
                              {
                                backgroundColor: selected ? colors.light.primary : c.background,
                                borderColor: selected ? colors.light.primary : c.border,
                              },
                            ]}
                            onPress={() => setAdjustmentDirection(direction)}
                          >
                            <Feather name={icon} size={17} color={selected ? "#fff" : c.foreground} />
                            <Text style={[styles.choiceBtnText, { color: selected ? "#fff" : c.foreground }]}>{label}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}

                {/* Quantity stepper */}
                <View style={styles.section}>
                  <Text style={[styles.label, { color: c.mutedForeground }]}>QUANTITY</Text>
                  <View style={styles.stepper}>
                    <TouchableOpacity style={[styles.stepBtn, { backgroundColor: c.muted }]} onPress={() => adjustQuantity(-1)}>
                      <Feather name="minus" size={20} color={c.foreground} />
                    </TouchableOpacity>
                    <TextInput
                      style={[
                        styles.quantityInput,
                        {
                          color: c.foreground,
                          borderColor: quantityIsValid ? c.border : colors.light.stockOut,
                          backgroundColor: c.background,
                        },
                      ]}
                      value={quantity}
                      onChangeText={(v) => {
                        if (/^\d*\.?\d*$/.test(v)) setQuantity(v);
                      }}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                    />
                    <TouchableOpacity style={[styles.stepBtn, { backgroundColor: c.muted }]} onPress={() => adjustQuantity(1)}>
                      <Feather name="plus" size={20} color={c.foreground} />
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Used In */}
                <View style={styles.section}>
                  <Text style={[styles.label, { color: c.mutedForeground }]}>USED IN *</Text>
                  <TextInput
                    style={[
                      styles.noteInput,
                      {
                        color: c.foreground,
                        borderColor: usedIn.trim() ? c.border : colors.light.stockOut,
                        backgroundColor: c.background,
                      },
                    ]}
                    value={usedIn}
                    onChangeText={setUsedIn}
                    placeholder="Required, e.g. Job No / Department / Machine"
                    placeholderTextColor={c.mutedForeground}
                    multiline
                    maxLength={120}
                  />
                  {!usedIn.trim() && <Text style={[styles.errorText, { color: colors.light.stockOut }]}>Used In is required.</Text>}
                </View>

                {/* Save button */}
                <TouchableOpacity
                  style={[
                    styles.submitBtn,
                    {
                      backgroundColor: canSubmit ? getMovementColor(movementType) : c.muted,
                    },
                  ]}
                  onPress={submitTransaction}
                  disabled={!canSubmit}
                >
                  {isSubmitting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Feather name="check" size={20} color="#fff" />
                      <Text style={styles.actionBtnText}>Save Movement</Text>
                    </>
                  )}
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const CORNER_SIZE = 28;
const CORNER_THICKNESS = 4;
const FRAME_SIZE = 240;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  topBar: { paddingHorizontal: 16, paddingBottom: 12 },
  topBarContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  topBarTitle: {
    color: "#fff",
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
  },
  serverBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    gap: 6,
  },
  serverDot: { width: 6, height: 6, borderRadius: 3 },
  serverBadgeText: { color: "#fff", fontSize: 12, fontFamily: "Inter_500Medium" },
  scanFrame: {
    width: FRAME_SIZE,
    height: FRAME_SIZE,
    position: "relative",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: -30,
  },
  corner: {
    position: "absolute",
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderColor: "#fff",
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderTopLeftRadius: 4,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderTopRightRadius: 4,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderBottomLeftRadius: 4,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderBottomRightRadius: 4,
  },
  scanHint: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginTop: FRAME_SIZE / 2 + 20,
  },
  modalBackdrop: {
    flex: 1,
  },
  modalWrapper: {
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 20,
    minHeight: 320,
    maxHeight: "92%",
  },
  sheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: "#D1D5DB",
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 20,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 24,
  },
  productIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  productInfo: { flex: 1 },
  productName: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 2,
  },
  productId: { fontSize: 13, fontFamily: "Inter_400Regular" },
  closeBtn: { padding: 4 },
  section: { marginBottom: 20 },
  label: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  detailCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  detailLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  detailValue: {
    flex: 1,
    textAlign: "right",
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  errorText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    marginTop: 8,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  stepBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  quantityInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderRadius: 12,
    textAlign: "center",
    fontSize: 22,
    fontFamily: "Inter_600SemiBold",
  },
  noteInput: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    minHeight: 60,
    maxHeight: 100,
  },
  actionRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 8,
  },
  choiceBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 8,
  },
  choiceBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  submitBtn: {
    height: 52,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginBottom: 8,
  },
  actionBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  feedbackContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 48,
    gap: 16,
  },
  feedbackText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
    paddingHorizontal: 24,
  },
  permissionContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  permissionTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    marginTop: 16,
  },
  permissionText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  permissionBtn: {
    marginTop: 8,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 14,
  },
  permissionBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  webScanBtn: {
    marginTop: 20,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1.5,
  },
});
