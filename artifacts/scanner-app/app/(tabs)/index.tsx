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

interface ScannedProduct {
  qrData: string;
  productId: string;
  productName: string;
}

function parseQR(raw: string): ScannedProduct {
  try {
    const obj = JSON.parse(raw);
    return {
      qrData: raw,
      productId: obj.id ?? obj.productId ?? raw,
      productName: obj.name ?? obj.productName ?? raw,
    };
  } catch {
    return {
      qrData: raw,
      productId: raw,
      productName: raw,
    };
  }
}

export default function ScannerScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { addTransaction, isSubmitting, serverUrl } = useSync();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [product, setProduct] = useState<ScannedProduct | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState<"success" | "error" | null>(null);
  const lastScanTime = useRef<number>(0);

  const handleBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      const now = Date.now();
      if (now - lastScanTime.current < DEBOUNCE_MS) return;
      lastScanTime.current = now;

      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setScanned(true);
      setProduct(parseQR(data));
      setQuantity("1");
      setNote("");
      setFeedback(null);
      setModalVisible(true);
    },
    []
  );

  const resetScanner = () => {
    setScanned(false);
    setModalVisible(false);
    setProduct(null);
    setFeedback(null);
  };

  const submitTransaction = async (type: "stock_in" | "stock_out") => {
    if (!product) return;
    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) return;

    const ok = await addTransaction({
      productId: product.productId,
      productName: product.productName,
      quantity: type === "stock_in" ? qty : -qty,
      type,
      note: note.trim() || undefined,
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
        <Text style={[styles.permissionTitle, { color: c.foreground }]}>
          Camera Access Required
        </Text>
        <Text style={[styles.permissionText, { color: c.mutedForeground }]}>
          Allow camera access to scan QR codes
        </Text>
        <TouchableOpacity
          style={[styles.permissionBtn, { backgroundColor: c.primary }]}
          onPress={requestPermission}
        >
          <Text style={[styles.permissionBtnText, { color: c.primaryForeground }]}>
            Allow Camera
          </Text>
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
          style={[StyleSheet.absoluteFillObject, { backgroundColor: "#111827", alignItems: "center", justifyContent: "center" }]}
        >
          <Feather name="camera" size={48} color="#374151" />
          <Text style={{ color: "#6B7280", marginTop: 12, fontSize: 14 }}>
            Camera preview not available on web
          </Text>
          <TouchableOpacity
            style={[styles.webScanBtn, { borderColor: colors.light.primary }]}
            onPress={() =>
              handleBarcodeScanned({ data: `PROD-${String(Math.floor(Math.random() * 100) + 1).padStart(3, "0")}` })
            }
          >
            <Text style={{ color: colors.light.primary, fontWeight: "600" }}>
              Simulate Scan
            </Text>
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
            <View
              style={[
                styles.serverDot,
                { backgroundColor: serverUrl ? "#86efac" : "#fca5a5" },
              ]}
            />
            <Text style={styles.serverBadgeText}>
              {serverUrl ? "Connected" : "No server"}
            </Text>
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
          {!scanned && (
            <Text style={styles.scanHint}>Align QR code within frame</Text>
          )}
        </View>
      </View>

      {/* Transaction Modal */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={resetScanner}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={resetScanner}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalWrapper}
        >
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
                  name={feedback === "success" ? "check-circle" : "wifi-off"}
                  size={52}
                  color={
                    feedback === "success"
                      ? colors.light.stockIn
                      : colors.light.pending
                  }
                />
                <Text
                  style={[
                    styles.feedbackText,
                    {
                      color:
                        feedback === "success"
                          ? colors.light.stockIn
                          : colors.light.pending,
                    },
                  ]}
                >
                  {feedback === "success"
                    ? "Saved!"
                    : "Queued — will sync when server available"}
                </Text>
              </View>
            ) : (
              <ScrollView
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                {/* Handle */}
                <View style={styles.sheetHandle} />

                {/* Product */}
                <View style={styles.sheetHeader}>
                  <View
                    style={[
                      styles.productIcon,
                      { backgroundColor: c.muted },
                    ]}
                  >
                    <Feather name="package" size={24} color={c.mutedForeground} />
                  </View>
                  <View style={styles.productInfo}>
                    <Text style={[styles.productName, { color: c.foreground }]}>
                      {product?.productName ?? ""}
                    </Text>
                    <Text style={[styles.productId, { color: c.mutedForeground }]}>
                      {product?.productId ?? ""}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={resetScanner} style={styles.closeBtn}>
                    <Feather name="x" size={20} color={c.mutedForeground} />
                  </TouchableOpacity>
                </View>

                {/* Quantity stepper */}
                <View style={styles.section}>
                  <Text style={[styles.label, { color: c.mutedForeground }]}>
                    QUANTITY
                  </Text>
                  <View style={styles.stepper}>
                    <TouchableOpacity
                      style={[styles.stepBtn, { backgroundColor: c.muted }]}
                      onPress={() => adjustQuantity(-1)}
                    >
                      <Feather name="minus" size={20} color={c.foreground} />
                    </TouchableOpacity>
                    <TextInput
                      style={[
                        styles.quantityInput,
                        {
                          color: c.foreground,
                          borderColor: c.border,
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
                    <TouchableOpacity
                      style={[styles.stepBtn, { backgroundColor: c.muted }]}
                      onPress={() => adjustQuantity(1)}
                    >
                      <Feather name="plus" size={20} color={c.foreground} />
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Note */}
                <View style={styles.section}>
                  <Text style={[styles.label, { color: c.mutedForeground }]}>
                    NOTE (OPTIONAL)
                  </Text>
                  <TextInput
                    style={[
                      styles.noteInput,
                      {
                        color: c.foreground,
                        borderColor: c.border,
                        backgroundColor: c.background,
                      },
                    ]}
                    value={note}
                    onChangeText={setNote}
                    placeholder="Add a note..."
                    placeholderTextColor={c.mutedForeground}
                    multiline
                    maxLength={120}
                  />
                </View>

                {/* Action buttons */}
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={[
                      styles.actionBtn,
                      { backgroundColor: colors.light.stockOut },
                    ]}
                    onPress={() => submitTransaction("stock_out")}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <>
                        <Feather name="minus-circle" size={20} color="#fff" />
                        <Text style={styles.actionBtnText}>Stock Out</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.actionBtn,
                      { backgroundColor: colors.light.stockIn },
                    ]}
                    onPress={() => submitTransaction("stock_in")}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <>
                        <Feather name="plus-circle" size={20} color="#fff" />
                        <Text style={styles.actionBtnText}>Stock In</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
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
  actionBtn: {
    flex: 1,
    height: 52,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
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
