import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from "expo-camera";
import Feather from "@expo/vector-icons/Feather";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

type ServerQrScannerProps = {
  visible: boolean;
  onCancel: () => void;
  onServerUrl: (url: string) => Promise<void> | void;
};

type ServerQrPayload = {
  type?: unknown;
  version?: unknown;
  url?: unknown;
};

function normalizeServerUrl(rawValue: string): string {
  const trimmed = rawValue.trim();
  let candidate = trimmed;

  if (trimmed.startsWith("{")) {
    const payload = JSON.parse(trimmed) as ServerQrPayload;

    if (
      payload.type !== "inventory-scanner/server" ||
      typeof payload.url !== "string"
    ) {
      throw new Error("This is not an Inventory Scanner setup QR code.");
    }

    candidate = payload.url;
  }

  const parsed = new URL(candidate);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The setup QR code does not contain an HTTP server URL.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Server URLs containing credentials are not supported.");
  }

  return parsed.origin;
}

export default function ServerQrScanner({
  visible,
  onCancel,
  onServerUrl,
}: ServerQrScannerProps) {
  const c = useColors();
  const [permission, requestPermission] = useCameraPermissions();
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setIsProcessing(false);
      setMessage(null);
    }
  }, [visible]);

  const handleBarcodeScanned = async ({ data }: BarcodeScanningResult) => {
    if (isProcessing) {
      return;
    }

    setIsProcessing(true);
    setMessage("Checking server address…");

    try {
      const url = normalizeServerUrl(data);
      await onServerUrl(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setTimeout(() => {
        setIsProcessing(false);
      }, 1500);
    }
  };

  return (
    <Modal
      animationType="slide"
      presentationStyle="fullScreen"
      visible={visible}
      onRequestClose={onCancel}
    >
      <SafeAreaView style={[styles.safeArea, { backgroundColor: c.background }]}>
        <View style={styles.header}>
          <View>
            <Text style={[styles.title, { color: c.foreground }]}>Connect scanner</Text>
            <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
              Scan the setup QR shown in the laptop dashboard.
            </Text>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Close QR scanner"
            onPress={onCancel}
            style={[styles.closeButton, { backgroundColor: c.muted }]}
          >
            <Feather name="x" size={22} color={c.foreground} />
          </TouchableOpacity>
        </View>

        {!permission ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={c.primary} />
          </View>
        ) : !permission.granted ? (
          <View style={styles.centered}>
            <Feather name="camera" size={38} color={c.mutedForeground} />
            <Text style={[styles.permissionTitle, { color: c.foreground }]}>
              Camera permission required
            </Text>
            <Text style={[styles.permissionText, { color: c.mutedForeground }]}>
              The camera is only used to read the launcher setup QR code.
            </Text>
            <TouchableOpacity
              style={[styles.permissionButton, { backgroundColor: c.primary }]}
              onPress={requestPermission}
            >
              <Text style={styles.permissionButtonText}>Allow camera</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.cameraContainer}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={isProcessing ? undefined : handleBarcodeScanned}
            />
            <View pointerEvents="none" style={styles.overlay}>
              <View style={styles.scanFrame} />
              <View style={styles.messageContainer}>
                {isProcessing && <ActivityIndicator size="small" color="#ffffff" />}
                <Text style={styles.messageText}>
                  {message ?? "Point the camera at the setup QR code"}
                </Text>
              </View>
            </View>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  title: { fontSize: 24, fontFamily: "Inter_700Bold" },
  subtitle: {
    maxWidth: 280,
    marginTop: 5,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: "Inter_400Regular",
  },
  closeButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 14,
  },
  permissionTitle: {
    marginTop: 4,
    fontSize: 20,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  permissionText: {
    maxWidth: 340,
    fontSize: 14,
    lineHeight: 21,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  permissionButton: {
    marginTop: 8,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  permissionButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  cameraContainer: {
    flex: 1,
    overflow: "hidden",
    backgroundColor: "#000000",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.18)",
  },
  scanFrame: {
    width: 260,
    height: 260,
    borderWidth: 3,
    borderColor: "#ffffff",
    borderRadius: 24,
    backgroundColor: "transparent",
  },
  messageContainer: {
    position: "absolute",
    bottom: 36,
    left: 24,
    right: 24,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderRadius: 14,
    backgroundColor: "rgba(0, 0, 0, 0.72)",
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  messageText: {
    flexShrink: 1,
    color: "#ffffff",
    fontSize: 14,
    lineHeight: 20,
    fontFamily: "Inter_500Medium",
    textAlign: "center",
  },
});
