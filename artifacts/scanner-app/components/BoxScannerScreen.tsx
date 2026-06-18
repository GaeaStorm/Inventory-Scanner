import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Vibration,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import colors from "@/constants/colors";
import { useSync } from "@/context/SyncContext";
import { useColors } from "@/hooks/useColors";
import {
  cacheStoresBox,
  cacheStoresCatalog,
  createStoresClientTransactionId,
  enqueueStoresOperation,
  getStoresQueueSummary,
  loadCachedStoresBox,
  loadCachedStoresCatalog,
  synchronizeStoresQueue,
  type OfflineQueueSummary,
} from "@/lib/storesOfflineQueue";

const DEBOUNCE_MS = 2000;
const MAX_BOX_ITEMS = 5;

type Workflow = "MATERIAL_OUT" | "ADJUSTMENT";
type AdjustmentDirection = "RETURN_TO_STOCK" | "ADDITIONAL_OUT";
type AdjustmentReason = "UNUSED_MATERIAL" | "MISCOUNT" | "DATA_ENTRY_ERROR" | "DAMAGE_OR_LOSS" | "OTHER";

interface CatalogItem {
  id: number;
  tallyGuid: string;
  name: string;
  parentName: string;
  hasBom: boolean;
  localAvailableQuantity: number;
}

interface BoxItem {
  tallyItemGuid: string;
  itemName: string;
}

interface ScannedBox {
  boxId: string;
  companyId: string;
  revision: number;
  items: BoxItem[];
  legacy: boolean;
}

interface CatalogResponse {
  stockItems: CatalogItem[];
  destinations: CatalogItem[];
}

interface AdjustmentContext {
  materialOutVoucherId: string;
  eventDate: string;
  issuedItemName: string;
  destinationName: string;
  pendingQuantity: number;
  latestMovementId: string;
  latestMovementQuantity: number;
  latestMovementCreatedAt: string;
  status: string;
  tallyVoucherNumber: string;
}

interface AdjustmentReasonOption {
  id: AdjustmentReason;
  name: string;
  detail: string;
}

const ADJUSTMENT_REASONS: AdjustmentReasonOption[] = [
  { id: "UNUSED_MATERIAL", name: "Unused material", detail: "Material was issued but not consumed." },
  { id: "MISCOUNT", name: "Miscount", detail: "The physical count was entered or observed incorrectly." },
  { id: "DATA_ENTRY_ERROR", name: "Data-entry error", detail: "The earlier issued quantity was entered incorrectly." },
  { id: "DAMAGE_OR_LOSS", name: "Damage or loss", detail: "Stock is unavailable because it was damaged or lost." },
  { id: "OTHER", name: "Other", detail: "A different reason; notes are required." },
];

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function parseQr(raw: string): ScannedBox {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const rawItems = Array.isArray(parsed.items) ? parsed.items : null;
  if (rawItems) {
    if (rawItems.length < 1 || rawItems.length > MAX_BOX_ITEMS) {
      throw new Error(`A box QR must contain between 1 and ${MAX_BOX_ITEMS} items.`);
    }
    return {
      boxId: text(parsed.boxId ?? parsed.boxRef ?? parsed.refNo),
      companyId: text(parsed.companyId),
      revision: Number(parsed.revision ?? parsed.version ?? 1),
      items: rawItems.map((value) => {
        const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
        return {
          tallyItemGuid: text(item.tallyItemGuid ?? item.itemCode ?? item.item_code),
          itemName: text(item.itemName ?? item.item_name),
        };
      }),
      legacy: Number(parsed.version ?? 1) < 3,
    };
  }
  return {
    boxId: text(parsed.boxId ?? parsed.boxRef ?? parsed.refNo ?? parsed.ref_no),
    companyId: text(parsed.companyId),
    revision: 1,
    items: [{
      tallyItemGuid: text(parsed.tallyItemGuid ?? parsed.itemCode ?? parsed.item_code),
      itemName: text(parsed.itemName ?? parsed.item_name),
    }],
    legacy: true,
  };
}

function normalizedServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/$/, "");
}

function today(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function apiRequest<T>(serverUrl: string, path: string, init?: RequestInit): Promise<T> {
  if (!serverUrl) throw new Error("No desktop server is configured. Scan the connection QR in Settings first.");
  const response = await fetch(`${normalizedServerUrl(serverUrl)}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    throw new ApiRequestError(body.error || `Desktop server returned ${response.status}.`, response.status);
  }
  return body as T;
}

function Dropdown<T extends { id?: number | string; tallyGuid?: string; name?: string }>(props: {
  label: string;
  value: T | null;
  values: T[];
  display: (value: T) => string;
  detail?: (value: T) => string;
  onChange: (value: T) => void;
  colors: ReturnType<typeof useColors>;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = props.values.filter((value) => {
    const haystack = `${props.display(value)} ${props.detail?.(value) ?? ""}`.toLocaleLowerCase();
    return !query.trim() || haystack.includes(query.trim().toLocaleLowerCase());
  });
  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: props.colors.mutedForeground }]}>{props.label}{props.required ? " *" : ""}</Text>
      <TouchableOpacity style={[styles.dropdownButton, { borderColor: props.colors.border, backgroundColor: props.colors.background }]} onPress={() => setOpen((current) => !current)}>
        <View style={styles.dropdownText}><Text style={[styles.dropdownPrimary, { color: props.colors.foreground }]}>{props.value ? props.display(props.value) : "Select…"}</Text>{props.value && props.detail && <Text style={[styles.dropdownSecondary, { color: props.colors.mutedForeground }]}>{props.detail(props.value)}</Text>}</View>
        <Feather name={open ? "chevron-up" : "chevron-down"} size={20} color={props.colors.mutedForeground} />
      </TouchableOpacity>
      {open && <View style={[styles.dropdownMenu, { borderColor: props.colors.border, backgroundColor: props.colors.background }]}>
        <TextInput value={query} onChangeText={setQuery} placeholder="Search…" placeholderTextColor={props.colors.mutedForeground} style={[styles.dropdownSearch, { borderColor: props.colors.border, color: props.colors.foreground }]} />
        <ScrollView nestedScrollEnabled style={styles.dropdownScroll}>
          {filtered.map((value, index) => <TouchableOpacity key={`${value.id ?? value.tallyGuid ?? props.display(value)}-${index}`} style={[styles.dropdownOption, index > 0 && { borderTopColor: props.colors.border, borderTopWidth: StyleSheet.hairlineWidth }]} onPress={() => { props.onChange(value); setOpen(false); setQuery(""); }}><View style={styles.dropdownText}><Text style={[styles.dropdownPrimary, { color: props.colors.foreground }]}>{props.display(value)}</Text>{props.detail && <Text style={[styles.dropdownSecondary, { color: props.colors.mutedForeground }]}>{props.detail(value)}</Text>}</View></TouchableOpacity>)}
          {filtered.length === 0 && <Text style={[styles.emptyText, { color: props.colors.mutedForeground }]}>No matches.</Text>}
        </ScrollView>
      </View>}
    </View>
  );
}

export default function BoxScannerScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { serverUrl } = useSync();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [scanArmed, setScanArmed] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [loadingBox, setLoadingBox] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [box, setBox] = useState<ScannedBox | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null);
  const [workflow, setWorkflow] = useState<Workflow>("MATERIAL_OUT");
  const [quantity, setQuantity] = useState("1");
  const [destination, setDestination] = useState<CatalogItem | null>(null);
  const [adjustmentDirection, setAdjustmentDirection] = useState<AdjustmentDirection>("RETURN_TO_STOCK");
  const [adjustmentReason, setAdjustmentReason] = useState<AdjustmentReasonOption>(ADJUSTMENT_REASONS[0]);
  const [adjustmentNote, setAdjustmentNote] = useState("");
  const [adjustmentConfirmed, setAdjustmentConfirmed] = useState(false);
  const [adjustmentContext, setAdjustmentContext] = useState<AdjustmentContext | null>(null);
  const [adjustmentContextError, setAdjustmentContextError] = useState("");
  const [loadingAdjustmentContext, setLoadingAdjustmentContext] = useState(false);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [connectionState, setConnectionState] = useState<"online" | "offline" | "unknown">("unknown");
  const [queueSummary, setQueueSummary] = useState<OfflineQueueSummary>({ pending: 0, rejected: 0, total: 0 });
  const [usingCachedData, setUsingCachedData] = useState(false);
  const lastScanTime = useRef(0);

  const boxCatalogItems = useMemo(() => {
    if (!box || !catalog) return [];
    return box.items.map((item) => catalog.stockItems.find((candidate) =>
      candidate.tallyGuid === item.tallyItemGuid || candidate.name.toLocaleLowerCase() === item.itemName.toLocaleLowerCase(),
    )).filter((value): value is CatalogItem => Boolean(value));
  }, [box, catalog]);

  useEffect(() => {
    let cancelled = false;
    const refreshQueue = async () => {
      try {
        const summary = serverUrl
          ? await synchronizeStoresQueue(serverUrl)
          : await getStoresQueueSummary();
        if (!cancelled) {
          setQueueSummary(summary);
          if (serverUrl) setConnectionState("online");
        }
      } catch {
        if (!cancelled) {
          setConnectionState("offline");
          setQueueSummary(await getStoresQueueSummary());
        }
      }
    };
    void refreshQueue();
    const timer = setInterval(() => void refreshQueue(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [serverUrl]);

  useEffect(() => {
    if (workflow !== "ADJUSTMENT" || !selectedItem || !destination || !serverUrl) {
      setAdjustmentContext(null);
      setAdjustmentContextError("");
      setLoadingAdjustmentContext(false);
      return;
    }

    let cancelled = false;
    setLoadingAdjustmentContext(true);
    setAdjustmentContext(null);
    setAdjustmentContextError("");
    const query = [
      `tallyItemGuid=${encodeURIComponent(selectedItem.tallyGuid)}`,
      `destinationTallyItemGuid=${encodeURIComponent(destination.tallyGuid)}`,
      `eventDate=${encodeURIComponent(today())}`,
    ].join("&");
    void apiRequest<AdjustmentContext>(
      serverUrl,
      `/api/stores/adjustment-context?${query}`,
    ).then((context) => {
      if (!cancelled) setAdjustmentContext(context);
    }).catch((reason: unknown) => {
      if (!cancelled) {
        if (reason instanceof ApiRequestError) {
          setConnectionState("online");
          setAdjustmentContextError(reason.message);
        } else {
          setConnectionState("offline");
          setAdjustmentContextError(
            `Desktop unavailable. This adjustment can still be queued and will be validated against the latest matching issue when synchronization resumes. ${reason instanceof Error ? reason.message : String(reason)}`,
          );
        }
      }
    }).finally(() => {
      if (!cancelled) setLoadingAdjustmentContext(false);
    });

    return () => {
      cancelled = true;
    };
  }, [workflow, selectedItem, destination, serverUrl]);

  const handleBarcodeScanned = useCallback(async ({ data }: { data: string }) => {
    const now = Date.now();
    if (now - lastScanTime.current < DEBOUNCE_MS) return;
    lastScanTime.current = now;
    if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    setScanArmed(false);
    setScanned(true);
    setModalVisible(true);
    setLoadingBox(true);
    setError(""); setSuccess(""); setWarning("");
    setSelectedItem(null); setDestination(null);
    setWorkflow("MATERIAL_OUT"); setQuantity("1");
    setAdjustmentDirection("RETURN_TO_STOCK");
    setAdjustmentReason(ADJUSTMENT_REASONS[0]);
    setAdjustmentNote("");
    setAdjustmentConfirmed(false);
    setAdjustmentContext(null);
    setAdjustmentContextError("");

    try {
      const scannedBox = parseQr(data);
      if (!scannedBox.boxId) throw new Error("The QR code does not contain a box identifier.");
      let nextCatalog: CatalogResponse | null = null;
      let authoritative: ScannedBox = scannedBox;
      let onlineFailure: unknown = null;

      try {
        nextCatalog = await apiRequest<CatalogResponse>(serverUrl, "/api/stores/catalog");
        const serverBox = await apiRequest<{ boxId: string; companyId: string; revision: number; items: BoxItem[] }>(
          serverUrl,
          `/api/stores/boxes/${encodeURIComponent(scannedBox.boxId)}`,
        );
        authoritative = { ...serverBox, legacy: false };
        await Promise.all([
          cacheStoresCatalog(serverUrl, nextCatalog),
          cacheStoresBox(serverUrl, authoritative),
        ]);
        setConnectionState("online");
        setUsingCachedData(false);
        if (scannedBox.revision && scannedBox.revision !== serverBox.revision) {
          setWarning(`Printed label revision ${scannedBox.revision} is old. Loaded current server revision ${serverBox.revision}.`);
        }
      } catch (reason) {
        onlineFailure = reason;
        if (reason instanceof ApiRequestError) {
          setConnectionState("online");
          if (nextCatalog && reason.status === 404 && scannedBox.legacy) {
            await cacheStoresCatalog(serverUrl, nextCatalog);
            setUsingCachedData(false);
            setWarning("This older label is not registered as a box. Using its embedded item list.");
          } else {
            throw reason;
          }
        } else {
          setConnectionState("offline");
          nextCatalog = await loadCachedStoresCatalog<CatalogResponse>(serverUrl);
          const cachedBox = await loadCachedStoresBox<{ boxId: string; companyId: string; revision: number; items: BoxItem[] }>(serverUrl, scannedBox.boxId);
          if (cachedBox) authoritative = { ...cachedBox, legacy: false };
          setUsingCachedData(true);
          setWarning(
            "Desktop unavailable. Using the last cached Stores Catalog and box contents; saved transactions will remain on this phone until synchronization resumes.",
          );
        }
      }

      if (!nextCatalog) {
        const fallbackItems: CatalogItem[] = authoritative.items.map((item, index) => ({
          id: -(index + 1),
          tallyGuid: item.tallyItemGuid,
          name: item.itemName,
          parentName: "QR fallback",
          hasBom: false,
          localAvailableQuantity: 0,
        }));
        nextCatalog = { stockItems: fallbackItems, destinations: [] };
      }
      setCatalog(nextCatalog);
      setBox(authoritative);
      const first = authoritative.items.map((item) => nextCatalog!.stockItems.find((candidate) =>
        candidate.tallyGuid === item.tallyItemGuid ||
        candidate.name.toLocaleLowerCase() === item.itemName.toLocaleLowerCase(),
      )).find(Boolean) ?? null;
      setSelectedItem(first);
      if (!first) throw new Error("None of the items on this label could be matched to the cached Tally Stock Items.");
      if (nextCatalog.destinations.length === 0 && onlineFailure) {
        setWarning((current) => `${current} No cached destination-product catalog is available yet, so this scan can be viewed but not submitted.`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      if (Platform.OS !== "web") Vibration.vibrate(200);
    } finally {
      setLoadingBox(false);
    }
  }, [serverUrl]);

  function reset(): void {
    setScanArmed(false); setScanned(false); setModalVisible(false); setBox(null); setSelectedItem(null); setError(""); setSuccess(""); setWarning(""); setUsingCachedData(false);
  }

  function toggleScanner(): void {
    if (scanArmed) {
      setScanArmed(false);
      return;
    }
    lastScanTime.current = 0;
    setScanned(false);
    setError("");
    setScanArmed(true);
    if (Platform.OS !== "web") void Haptics.selectionAsync();
  }

  async function submit(): Promise<void> {
    if (!box || !selectedItem || !destination) return;
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      setError("Quantity must be a positive whole number.");
      return;
    }

    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      if (workflow === "ADJUSTMENT") {
        if (!adjustmentConfirmed) {
          throw new Error("Confirm that this adjustment belongs to the selected item and destination.");
        }
        if (adjustmentReason.id === "OTHER" && !adjustmentNote.trim()) {
          throw new Error("Describe the adjustment when the reason is Other.");
        }
      }

      const clientTransactionId = await createStoresClientTransactionId();
      const payload = workflow === "MATERIAL_OUT"
        ? {
            clientTransactionId,
            boxId: box.boxId,
            tallyItemGuid: selectedItem.tallyGuid,
            destinationTallyItemGuid: destination.tallyGuid,
            quantity: qty,
            eventDate: today(),
          }
        : {
            clientTransactionId,
            boxId: box.boxId,
            tallyItemGuid: selectedItem.tallyGuid,
            destinationTallyItemGuid: destination.tallyGuid,
            quantity: qty,
            direction: adjustmentDirection,
            reason: adjustmentReason.id,
            note: adjustmentNote.trim(),
            eventDate: today(),
          };

      const queued = await enqueueStoresOperation({
        clientTransactionId,
        type: workflow,
        payload,
      });
      setQueueSummary(queued);

      try {
        const synchronized = await synchronizeStoresQueue(serverUrl);
        setQueueSummary(synchronized);
        setConnectionState("online");
        const stillQueued = synchronized.pending > 0;
        setSuccess(stillQueued
          ? `Saved safely on this phone. ${synchronized.pending} transaction${synchronized.pending === 1 ? "" : "s"} still waiting to synchronize.`
          : workflow === "MATERIAL_OUT"
            ? "Material Out synchronized with supplier-aware FIFO."
            : "Adjustment synchronized and validated by the desktop.");
      } catch {
        setConnectionState("offline");
        setQueueSummary(await getStoresQueueSummary());
        setSuccess("Saved safely on this phone. It will synchronize automatically when the desktop is reachable.");
      }
      if (Platform.OS !== "web") {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setTimeout(reset, 1600);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      if (Platform.OS !== "web") Vibration.vibrate(200);
    } finally {
      setSubmitting(false);
    }
  }

  if (!permission) return <View style={styles.container} />;
  if (!permission.granted) return <View style={[styles.permissionContainer, { backgroundColor: c.background }]}><Feather name="camera" size={48} color={c.mutedForeground} /><Text style={[styles.permissionTitle, { color: c.foreground }]}>Camera Access Required</Text><Text style={[styles.permissionText, { color: c.mutedForeground }]}>Allow camera access to scan inventory box labels.</Text><TouchableOpacity style={[styles.permissionBtn, { backgroundColor: colors.light.primary }]} onPress={requestPermission}><Text style={styles.permissionBtnText}>Allow Camera</Text></TouchableOpacity></View>;

  const validQuantity = Number.isInteger(Number(quantity)) && Number(quantity) > 0;
  const adjustmentReady = workflow !== "ADJUSTMENT" || Boolean(
    (adjustmentContext || connectionState !== "online") &&
    adjustmentConfirmed &&
    adjustmentReason &&
    (adjustmentReason.id !== "OTHER" || adjustmentNote.trim()),
  );
  const canSubmit = Boolean(selectedItem && destination && validQuantity && adjustmentReady);

  return (
    <View style={styles.container}>
      {Platform.OS !== "web" ? <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scanArmed && !scanned ? handleBarcodeScanned : undefined} /> : <View style={[StyleSheet.absoluteFill, styles.webFallback]}><Text style={styles.webText}>Camera preview unavailable on web.</Text>{scanArmed && <TouchableOpacity style={styles.webButton} onPress={() => void handleBarcodeScanned({ data: JSON.stringify({ type: "inventory-scanner/box", version: 3, companyId: "DEMO", boxId: "BOX-DEMO", revision: 1, items: [{ tallyItemGuid: "DEMO", itemName: "Demo Item" }] }) })}><Text style={styles.webText}>Simulate QR detection</Text></TouchableOpacity>}</View>}
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}><Text style={styles.topBarTitle}>Stores Scanner</Text><View style={[styles.serverBadge, { backgroundColor: connectionState === "online" ? "rgba(28,164,104,.8)" : connectionState === "offline" ? "rgba(180,83,9,.88)" : "rgba(80,80,80,.82)" }]}><Text style={styles.serverBadgeText}>{connectionState === "online" ? `Online${queueSummary.pending ? ` · ${queueSummary.pending} queued` : ""}` : connectionState === "offline" ? `Offline · ${queueSummary.pending} queued` : "Checking…"}</Text></View></View>
        <View style={[styles.scanFrame, !scanArmed && styles.scanFrameIdle]}><View style={[styles.corner, styles.cornerTL, !scanArmed && styles.cornerIdle]} /><View style={[styles.corner, styles.cornerTR, !scanArmed && styles.cornerIdle]} /><View style={[styles.corner, styles.cornerBL, !scanArmed && styles.cornerIdle]} /><View style={[styles.corner, styles.cornerBR, !scanArmed && styles.cornerIdle]} /><Text style={styles.scanHint}>{scanArmed ? "Scanning… hold the QR inside the frame" : "Scanner paused"}</Text></View>
        <View style={[styles.scanControls, { paddingBottom: Math.max(insets.bottom, 18) }]}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={scanArmed ? "Cancel QR scan" : "Start QR scan"} style={[styles.scanButton, scanArmed && styles.scanButtonArmed]} onPress={toggleScanner}>
            <Feather name={scanArmed ? "x" : "maximize"} size={22} color="#fff" />
            <Text style={styles.scanButtonText}>{scanArmed ? "Cancel scan" : "Scan QR code"}</Text>
          </TouchableOpacity>
          <Text style={styles.scanStatus}>{scanArmed ? "Only the next QR code will be accepted." : "Tap Scan when the correct box label is in view."}</Text>
        </View>
      </View>

      <Modal visible={modalVisible} transparent animationType="slide" onRequestClose={reset}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={[styles.sheet, { backgroundColor: c.card, paddingBottom: Math.max(insets.bottom, 14) }]}>
            <View style={styles.handle} />
            <View style={styles.header}><View style={[styles.icon, { backgroundColor: c.muted }]}><Feather name="package" size={24} color={colors.light.primary} /></View><View style={styles.headerText}><Text style={[styles.title, { color: c.foreground }]}>{box?.boxId || "Scanned box"}</Text><Text style={[styles.subtitle, { color: c.mutedForeground }]}>{box ? `Revision ${box.revision} · ${box.items.length} item${box.items.length === 1 ? "" : "s"}` : "Loading…"}</Text></View><TouchableOpacity onPress={reset}><Feather name="x" size={24} color={c.mutedForeground} /></TouchableOpacity></View>
            {loadingBox ? <View style={styles.feedback}><ActivityIndicator size="large" color={colors.light.primary} /><Text style={[styles.feedbackText, { color: c.foreground }]}>Loading current box contents…</Text></View> : success ? <View style={styles.feedback}><Feather name="check-circle" size={58} color={colors.light.stockIn} /><Text style={[styles.feedbackText, { color: c.foreground }]}>{success}</Text></View> : <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {warning ? <Text style={styles.warning}>{warning}</Text> : null}
              {usingCachedData ? <Text style={styles.offlineNotice}>Offline mode · cached box/catalog · {queueSummary.pending} waiting to sync</Text> : null}
              {queueSummary.rejected > 0 ? <Text style={styles.error}>{queueSummary.rejected} queued transaction{queueSummary.rejected === 1 ? "" : "s"} need review after the desktop rejected them.</Text> : null}
              {error ? <Text style={styles.error}>{error}</Text> : null}
              {catalog && <Dropdown label="ITEM IN BOX" value={selectedItem} values={boxCatalogItems} display={(item) => item.name} detail={(item) => `Available ${item.localAvailableQuantity}`} onChange={(item) => { setSelectedItem(item); setAdjustmentConfirmed(false); }} colors={c} required />}

              <View style={styles.section}>
                <Text style={[styles.label, { color: c.mutedForeground }]}>STORE WORKFLOW</Text>
                <View style={styles.workflowWrap}>{([
                  ["MATERIAL_OUT", "Material Out", "upload"],
                  ["ADJUSTMENT", "Adjustment", "sliders"],
                ] as const).map(([value, label, icon]) => <TouchableOpacity key={value} style={[styles.workflowButton, { borderColor: workflow === value ? colors.light.primary : c.border, backgroundColor: workflow === value ? colors.light.primary : c.background }]} onPress={() => { setWorkflow(value); setError(""); setAdjustmentConfirmed(false); }}><Feather name={icon} size={15} color={workflow === value ? "#fff" : c.foreground} /><Text style={[styles.workflowText, { color: workflow === value ? "#fff" : c.foreground }]}>{label}</Text></TouchableOpacity>)}</View>
              </View>

              {catalog && <Dropdown label="DESTINATION PRODUCT" value={destination} values={catalog.destinations} display={(item) => item.name} detail={(item) => item.hasBom ? "Has BOM" : item.parentName} onChange={(item) => { setDestination(item); setAdjustmentConfirmed(false); }} colors={c} required />}

              {workflow === "ADJUSTMENT" && <>
                <View style={styles.section}>
                  <Text style={[styles.label, { color: c.mutedForeground }]}>ADJUSTMENT EFFECT *</Text>
                  <View style={styles.workflowWrap}>
                    <TouchableOpacity style={[styles.workflowButton, { borderColor: adjustmentDirection === "RETURN_TO_STOCK" ? colors.light.primary : c.border, backgroundColor: adjustmentDirection === "RETURN_TO_STOCK" ? colors.light.primary : c.background }]} onPress={() => { setAdjustmentDirection("RETURN_TO_STOCK"); setAdjustmentConfirmed(false); }}><Feather name="corner-up-left" size={15} color={adjustmentDirection === "RETURN_TO_STOCK" ? "#fff" : c.foreground} /><Text style={[styles.workflowText, { color: adjustmentDirection === "RETURN_TO_STOCK" ? "#fff" : c.foreground }]}>Return count to stock</Text></TouchableOpacity>
                    <TouchableOpacity style={[styles.workflowButton, { borderColor: adjustmentDirection === "ADDITIONAL_OUT" ? colors.light.primary : c.border, backgroundColor: adjustmentDirection === "ADDITIONAL_OUT" ? colors.light.primary : c.background }]} onPress={() => { setAdjustmentDirection("ADDITIONAL_OUT"); setAdjustmentConfirmed(false); }}><Feather name="plus-circle" size={15} color={adjustmentDirection === "ADDITIONAL_OUT" ? "#fff" : c.foreground} /><Text style={[styles.workflowText, { color: adjustmentDirection === "ADDITIONAL_OUT" ? "#fff" : c.foreground }]}>Record additional issue</Text></TouchableOpacity>
                  </View>
                </View>

                <Dropdown label="CAUSE" value={adjustmentReason} values={ADJUSTMENT_REASONS} display={(reason) => reason.name} detail={(reason) => reason.detail} onChange={(reason) => setAdjustmentReason(reason)} colors={c} required />

                {adjustmentReason.id === "OTHER" && <View style={styles.section}><Text style={[styles.label, { color: c.mutedForeground }]}>ADJUSTMENT NOTES *</Text><TextInput value={adjustmentNote} onChangeText={setAdjustmentNote} multiline placeholder="Describe why this adjustment is needed" placeholderTextColor={c.mutedForeground} style={[styles.adjustmentNotes, { color: c.foreground, borderColor: c.border, backgroundColor: c.background }]} /></View>}

                <View style={[styles.adjustmentContext, { borderColor: c.border, backgroundColor: c.background }]}>
                  {loadingAdjustmentContext ? <><ActivityIndicator color={colors.light.primary} /><Text style={[styles.adjustmentContextText, { color: c.mutedForeground }]}>Finding the most recent matching Material Out for today…</Text></> : adjustmentContext ? <>
                    <View style={styles.adjustmentContextTitle}><Feather name="clock" size={17} color={colors.light.primary} /><Text style={[styles.dropdownPrimary, { color: c.foreground }]}>Most recent same-day issue found</Text></View>
                    <Text style={[styles.adjustmentContextText, { color: c.mutedForeground }]}>{adjustmentContext.issuedItemName} → {adjustmentContext.destinationName}</Text>
                    <Text style={[styles.adjustmentContextText, { color: c.mutedForeground }]}>Current pending total: {adjustmentContext.pendingQuantity} · Last transaction: {adjustmentContext.latestMovementQuantity}</Text>
                    <Text style={[styles.adjustmentContextMeta, { color: c.mutedForeground }]}>{new Date(adjustmentContext.latestMovementCreatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {adjustmentContext.status}</Text>
                  </> : <><Feather name={connectionState === "offline" ? "wifi-off" : "alert-circle"} size={18} color={connectionState === "offline" ? "#8a5a00" : "#b42318"} /><Text style={connectionState === "offline" ? [styles.adjustmentContextText, { color: "#8a5a00" }] : styles.adjustmentContextError}>{adjustmentContextError || "Select an item and destination to find today's matching Material Out."}</Text></>}
                </View>

                <TouchableOpacity style={[styles.confirmAdjustment, { borderColor: adjustmentConfirmed ? colors.light.primary : c.border, backgroundColor: adjustmentConfirmed ? "rgba(83,111,229,.10)" : c.background }]} disabled={!adjustmentContext && connectionState === "online"} onPress={() => setAdjustmentConfirmed((current) => !current)}><Feather name={adjustmentConfirmed ? "check-square" : "square"} size={19} color={adjustmentConfirmed ? colors.light.primary : c.mutedForeground} /><Text style={[styles.confirmAdjustmentText, { color: c.foreground }]}>I confirm this adjustment belongs to the selected item and destination. Offline entries will be matched and validated when synchronized.</Text></TouchableOpacity>
              </>}

              <View style={styles.section}><Text style={[styles.label, { color: c.mutedForeground }]}>QUANTITY (WHOLE COUNT) *</Text><View style={styles.stepper}><TouchableOpacity style={[styles.stepButton, { backgroundColor: c.muted }]} onPress={() => setQuantity(String(Math.max(1, Number(quantity || 1) - 1)))}><Feather name="minus" size={20} color={c.foreground} /></TouchableOpacity><TextInput value={quantity} onChangeText={(value) => /^\d*$/.test(value) && setQuantity(value)} keyboardType="number-pad" selectTextOnFocus style={[styles.quantityInput, { color: c.foreground, borderColor: c.border, backgroundColor: c.background }]} /><TouchableOpacity style={[styles.stepButton, { backgroundColor: c.muted }]} onPress={() => setQuantity(String(Number(quantity || 0) + 1))}><Feather name="plus" size={20} color={c.foreground} /></TouchableOpacity></View></View>

              <TouchableOpacity style={[styles.submitButton, { backgroundColor: canSubmit ? colors.light.primary : c.muted }]} disabled={!canSubmit || submitting} onPress={() => void submit()}>{submitting ? <ActivityIndicator color="#fff" /> : <><Feather name="check" size={20} color="#fff" /><Text style={styles.submitText}>Save stores transaction</Text></>}</TouchableOpacity>
            </ScrollView>}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const FRAME = 240;
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" }, overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" }, topBar: { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: 16, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, topBarTitle: { color: "#fff", fontSize: 18, fontFamily: "Inter_600SemiBold" }, serverBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20 }, serverBadgeText: { color: "#fff", fontSize: 12, fontFamily: "Inter_500Medium" }, scanFrame: { width: FRAME, height: FRAME, position: "relative", alignItems: "center", justifyContent: "flex-end" }, scanFrameIdle: { opacity: .55 }, corner: { position: "absolute", width: 28, height: 28, borderColor: "#fff" }, cornerIdle: { borderColor: "rgba(255,255,255,.55)" }, cornerTL: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4 }, cornerTR: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4 }, cornerBL: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4 }, cornerBR: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4 }, scanHint: { color: "rgba(255,255,255,.9)", marginBottom: -42, textAlign: "center" }, scanControls: { position: "absolute", left: 20, right: 20, bottom: 0, alignItems: "center", gap: 9 }, scanButton: { minWidth: 190, minHeight: 54, borderRadius: 27, paddingHorizontal: 24, backgroundColor: colors.light.primary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, shadowColor: "#000", shadowOpacity: .3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 6 }, scanButtonArmed: { backgroundColor: "#b42318" }, scanButtonText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" }, scanStatus: { color: "rgba(255,255,255,.88)", fontSize: 12, textAlign: "center", textShadowColor: "rgba(0,0,0,.8)", textShadowRadius: 3 }, modalBackdrop: { flex: 1, justifyContent: "flex-end" }, sheet: { maxHeight: "95%", minHeight: 360, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 8 }, handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: "#D1D5DB", alignSelf: "center", marginBottom: 16 }, header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 18 }, icon: { width: 46, height: 46, borderRadius: 12, alignItems: "center", justifyContent: "center" }, headerText: { flex: 1 }, title: { fontSize: 17, fontFamily: "Inter_600SemiBold" }, subtitle: { fontSize: 12, marginTop: 2 }, section: { marginBottom: 16 }, label: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: .7, marginBottom: 7 }, dropdownButton: { minHeight: 56, borderWidth: 1, borderRadius: 12, padding: 11, flexDirection: "row", alignItems: "center" }, dropdownText: { flex: 1 }, dropdownPrimary: { fontSize: 14, fontFamily: "Inter_600SemiBold" }, dropdownSecondary: { fontSize: 11, marginTop: 2 }, dropdownMenu: { borderWidth: 1, borderRadius: 12, marginTop: 5, overflow: "hidden" }, dropdownSearch: { margin: 8, height: 40, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10 }, dropdownScroll: { maxHeight: 190 }, dropdownOption: { minHeight: 52, padding: 10, justifyContent: "center" }, emptyText: { padding: 14, textAlign: "center" }, workflowWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, workflowButton: { flexGrow: 1, minWidth: "30%", minHeight: 46, borderWidth: 1, borderRadius: 12, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 }, workflowText: { fontSize: 12, fontFamily: "Inter_600SemiBold", textAlign: "center" }, exceptionToggle: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 }, exceptionText: { fontSize: 13 }, twoColumns: { flexDirection: "row", gap: 10, marginBottom: 16 }, flexField: { flex: 1 }, input: { minHeight: 44, borderWidth: 1, borderRadius: 11, paddingHorizontal: 10 }, stepper: { flexDirection: "row", gap: 12, alignItems: "center" }, stepButton: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" }, quantityInput: { flex: 1, height: 44, borderWidth: 1, borderRadius: 12, textAlign: "center", fontSize: 22, fontFamily: "Inter_600SemiBold" }, adjustmentNotes: { minHeight: 82, borderWidth: 1, borderRadius: 11, paddingHorizontal: 10, paddingVertical: 9, textAlignVertical: "top" }, adjustmentContext: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 12, gap: 5 }, adjustmentContextTitle: { flexDirection: "row", alignItems: "center", gap: 7 }, adjustmentContextText: { fontSize: 12, lineHeight: 17 }, adjustmentContextMeta: { fontSize: 11, marginTop: 2 }, adjustmentContextError: { flex: 1, color: "#b42318", fontSize: 12, lineHeight: 17 }, confirmAdjustment: { minHeight: 54, borderWidth: 1, borderRadius: 12, padding: 11, marginBottom: 16, flexDirection: "row", alignItems: "center", gap: 9 }, confirmAdjustmentText: { flex: 1, fontSize: 12, lineHeight: 17 }, submitButton: { height: 52, borderRadius: 14, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", marginBottom: 8 }, submitText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" }, warning: { color: "#8a5a00", backgroundColor: "#fff4cf", borderRadius: 10, padding: 10, marginBottom: 12, fontSize: 12 }, offlineNotice: { color: "#175cd3", backgroundColor: "#eff8ff", borderRadius: 10, padding: 10, marginBottom: 12, fontSize: 12 }, error: { color: "#b42318", backgroundColor: "#fee4e2", borderRadius: 10, padding: 10, marginBottom: 12, fontSize: 12 }, feedback: { minHeight: 260, alignItems: "center", justifyContent: "center", gap: 14 }, feedbackText: { fontSize: 15, textAlign: "center" }, permissionContainer: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 32 }, permissionTitle: { fontSize: 22, fontFamily: "Inter_700Bold", marginTop: 16 }, permissionText: { fontSize: 15, textAlign: "center" }, permissionBtn: { marginTop: 8, paddingHorizontal: 32, paddingVertical: 14, borderRadius: 14 }, permissionBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" }, webFallback: { alignItems: "center", justifyContent: "center", backgroundColor: "#111", gap: 16 }, webText: { color: "#fff" }, webButton: { borderWidth: 1, borderColor: "#fff", borderRadius: 10, padding: 12 },
});
