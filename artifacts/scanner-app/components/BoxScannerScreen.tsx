import React, { useCallback, useMemo, useRef, useState } from "react";
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

const DEBOUNCE_MS = 2000;
const MAX_BOX_ITEMS = 5;

type Workflow = "VENDOR_MATERIAL_IN" | "MATERIAL_OUT" | "RETURN_UNUSED";

interface CatalogItem {
  id: number;
  tallyGuid: string;
  name: string;
  parentName: string;
  hasBom: boolean;
  localAvailableQuantity: number;
}

interface Supplier {
  id: number;
  tallyGuid: string;
  name: string;
}

interface PurchaseOrderLine {
  tallyItemGuid: string;
  itemName: string;
  outstandingQuantity: number;
}

interface PurchaseOrder {
  id: number;
  voucherNumber: string;
  voucherDate: string;
  supplierId: number | null;
  supplierName: string;
  lines: PurchaseOrderLine[];
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
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
}

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

function clientId(): string {
  return `PHONE-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function apiRequest<T>(serverUrl: string, path: string, init?: RequestInit): Promise<T> {
  if (!serverUrl) throw new Error("No desktop server is configured. Scan the connection QR in Settings first.");
  const response = await fetch(`${normalizedServerUrl(serverUrl)}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Desktop server returned ${response.status}.`);
  return body as T;
}

function Dropdown<T extends { id?: number; tallyGuid?: string; name?: string }>(props: {
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
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [purchaseOrder, setPurchaseOrder] = useState<PurchaseOrder | null>(null);
  const [challanNumber, setChallanNumber] = useState("");
  const [challanDate, setChallanDate] = useState(today());
  const [nonPoException, setNonPoException] = useState(false);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const lastScanTime = useRef(0);

  const boxCatalogItems = useMemo(() => {
    if (!box || !catalog) return [];
    return box.items.map((item) => catalog.stockItems.find((candidate) =>
      candidate.tallyGuid === item.tallyItemGuid || candidate.name.toLocaleLowerCase() === item.itemName.toLocaleLowerCase(),
    )).filter((value): value is CatalogItem => Boolean(value));
  }, [box, catalog]);

  const relevantPurchaseOrders = useMemo(() => {
    if (!catalog || !selectedItem) return [];
    return catalog.purchaseOrders.filter((order) =>
      (!supplier || order.supplierId === supplier.id) &&
      order.lines.some((line) => line.tallyItemGuid === selectedItem.tallyGuid && line.outstandingQuantity > 0),
    );
  }, [catalog, selectedItem, supplier]);

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
    setSelectedItem(null); setDestination(null); setSupplier(null); setPurchaseOrder(null);
    setWorkflow("MATERIAL_OUT"); setQuantity("1"); setChallanNumber(""); setChallanDate(today()); setNonPoException(false);

    try {
      const scannedBox = parseQr(data);
      if (!scannedBox.boxId) throw new Error("The QR code does not contain a box identifier.");
      const nextCatalog = await apiRequest<CatalogResponse>(serverUrl, "/api/stores/catalog");
      setCatalog(nextCatalog);
      let authoritative = scannedBox;
      try {
        const serverBox = await apiRequest<{ boxId: string; companyId: string; revision: number; items: BoxItem[] }>(serverUrl, `/api/stores/boxes/${encodeURIComponent(scannedBox.boxId)}`);
        authoritative = { ...serverBox, legacy: false };
        if (scannedBox.revision && scannedBox.revision !== serverBox.revision) {
          setWarning(`Printed label revision ${scannedBox.revision} is old. Loaded current server revision ${serverBox.revision}.`);
        }
      } catch (reason) {
        if (!scannedBox.legacy) throw reason;
        setWarning("The box is not in the desktop database. Using the embedded legacy label as an offline fallback.");
      }
      setBox(authoritative);
      const first = authoritative.items.map((item) => nextCatalog.stockItems.find((candidate) => candidate.tallyGuid === item.tallyItemGuid || candidate.name.toLocaleLowerCase() === item.itemName.toLocaleLowerCase())).find(Boolean) ?? null;
      setSelectedItem(first);
      if (!first) throw new Error("None of the items on this label could be matched to the synchronized Tally Stock Items.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      if (Platform.OS !== "web") Vibration.vibrate(200);
    } finally {
      setLoadingBox(false);
    }
  }, [serverUrl]);

  function reset(): void {
    setScanArmed(false); setScanned(false); setModalVisible(false); setBox(null); setSelectedItem(null); setError(""); setSuccess(""); setWarning("");
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
    if (!box || !selectedItem) return;
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) { setError("Quantity must be a positive whole number."); return; }
    setSubmitting(true); setError(""); setSuccess("");
    try {
      if (workflow === "VENDOR_MATERIAL_IN") {
        if (!supplier) throw new Error("Select a supplier.");
        if (!purchaseOrder && !nonPoException) throw new Error("Select a Purchase Order or mark this as a non-PO exception.");
        if (!challanNumber.trim()) throw new Error("Supplier challan number is required.");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(challanDate)) throw new Error("Challan date must use YYYY-MM-DD.");
        await apiRequest(serverUrl, "/api/stores/vendor-receipts", {
          method: "POST",
          body: JSON.stringify({
            clientTransactionId: clientId(), boxId: box.boxId,
            tallyItemGuid: selectedItem.tallyGuid, supplierId: supplier.id,
            purchaseOrderId: purchaseOrder?.id ?? null, challanNumber: challanNumber.trim(),
            challanDate, quantity: qty, receiptDate: today(), nonPoException,
          }),
        });
      } else {
        if (!destination) throw new Error("Select the destination product.");
        const endpoint = workflow === "MATERIAL_OUT" ? "/api/stores/material-out" : "/api/stores/return-unused";
        await apiRequest(serverUrl, endpoint, {
          method: "POST",
          body: JSON.stringify({
            clientTransactionId: clientId(), boxId: box.boxId,
            tallyItemGuid: selectedItem.tallyGuid,
            destinationTallyItemGuid: destination.tallyGuid,
            quantity: qty, eventDate: today(),
          }),
        });
      }
      setSuccess(workflow === "VENDOR_MATERIAL_IN" ? "Vendor receipt added to the GRN review queue." : workflow === "MATERIAL_OUT" ? "Material Out recorded with supplier-aware FIFO." : "Unused material restored to the original FIFO lots.");
      if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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

  const canSubmit = Boolean(selectedItem && Number.isInteger(Number(quantity)) && Number(quantity) > 0 && (workflow === "VENDOR_MATERIAL_IN" ? supplier && challanNumber.trim() && (purchaseOrder || nonPoException) : destination));

  return (
    <View style={styles.container}>
      {Platform.OS !== "web" ? <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scanArmed && !scanned ? handleBarcodeScanned : undefined} /> : <View style={[StyleSheet.absoluteFill, styles.webFallback]}><Text style={styles.webText}>Camera preview unavailable on web.</Text>{scanArmed && <TouchableOpacity style={styles.webButton} onPress={() => void handleBarcodeScanned({ data: JSON.stringify({ type: "inventory-scanner/box", version: 3, companyId: "DEMO", boxId: "BOX-DEMO", revision: 1, items: [{ tallyItemGuid: "DEMO", itemName: "Demo Item" }] }) })}><Text style={styles.webText}>Simulate QR detection</Text></TouchableOpacity>}</View>}
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}><Text style={styles.topBarTitle}>Stores Scanner</Text><View style={[styles.serverBadge, { backgroundColor: serverUrl ? "rgba(28,164,104,.8)" : "rgba(220,38,38,.8)" }]}><Text style={styles.serverBadgeText}>{serverUrl ? "Connected" : "No server"}</Text></View></View>
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
              {error ? <Text style={styles.error}>{error}</Text> : null}
              {catalog && <Dropdown label="ITEM IN BOX" value={selectedItem} values={boxCatalogItems} display={(item) => item.name} detail={(item) => `Available ${item.localAvailableQuantity}`} onChange={(item) => { setSelectedItem(item); setPurchaseOrder(null); }} colors={c} required />}

              <View style={styles.section}><Text style={[styles.label, { color: c.mutedForeground }]}>STORE WORKFLOW</Text><View style={styles.workflowWrap}>{([
                ["VENDOR_MATERIAL_IN", "Vendor Material In", "download"],
                ["MATERIAL_OUT", "Material Out", "upload"],
                ["RETURN_UNUSED", "Return Unused", "rotate-ccw"],
              ] as const).map(([value, label, icon]) => <TouchableOpacity key={value} style={[styles.workflowButton, { borderColor: workflow === value ? colors.light.primary : c.border, backgroundColor: workflow === value ? colors.light.primary : c.background }]} onPress={() => { setWorkflow(value); setError(""); }}><Feather name={icon} size={15} color={workflow === value ? "#fff" : c.foreground} /><Text style={[styles.workflowText, { color: workflow === value ? "#fff" : c.foreground }]}>{label}</Text></TouchableOpacity>)}</View></View>

              {workflow === "VENDOR_MATERIAL_IN" && catalog && <>
                <Dropdown label="SUPPLIER" value={supplier} values={catalog.suppliers} display={(value) => value.name} onChange={(value) => { setSupplier(value); setPurchaseOrder(null); }} colors={c} required />
                <Dropdown label="PURCHASE ORDER" value={purchaseOrder} values={relevantPurchaseOrders} display={(value) => value.voucherNumber} detail={(value) => `${value.voucherDate} · ${value.supplierName}`} onChange={(value) => { setPurchaseOrder(value); const linked = catalog.suppliers.find((candidate) => candidate.id === value.supplierId); if (linked) setSupplier(linked); setNonPoException(false); }} colors={c} />
                <TouchableOpacity style={styles.exceptionToggle} onPress={() => { setNonPoException((current) => !current); if (!nonPoException) setPurchaseOrder(null); }}><Feather name={nonPoException ? "check-square" : "square"} size={18} color={nonPoException ? colors.light.primary : c.mutedForeground} /><Text style={[styles.exceptionText, { color: c.foreground }]}>Non-PO receipt exception (requires review)</Text></TouchableOpacity>
                <View style={styles.twoColumns}><View style={styles.flexField}><Text style={[styles.label, { color: c.mutedForeground }]}>CHALLAN NUMBER *</Text><TextInput value={challanNumber} onChangeText={setChallanNumber} style={[styles.input, { color: c.foreground, borderColor: c.border, backgroundColor: c.background }]} /></View><View style={styles.flexField}><Text style={[styles.label, { color: c.mutedForeground }]}>CHALLAN DATE *</Text><TextInput value={challanDate} onChangeText={setChallanDate} placeholder="YYYY-MM-DD" style={[styles.input, { color: c.foreground, borderColor: c.border, backgroundColor: c.background }]} /></View></View>
              </>}

              {(workflow === "MATERIAL_OUT" || workflow === "RETURN_UNUSED") && catalog && <Dropdown label="DESTINATION PRODUCT" value={destination} values={catalog.destinations} display={(item) => item.name} detail={(item) => item.hasBom ? "Has BOM" : item.parentName} onChange={setDestination} colors={c} required />}

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
  container: { flex: 1, backgroundColor: "#000" }, overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" }, topBar: { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: 16, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, topBarTitle: { color: "#fff", fontSize: 18, fontFamily: "Inter_600SemiBold" }, serverBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20 }, serverBadgeText: { color: "#fff", fontSize: 12, fontFamily: "Inter_500Medium" }, scanFrame: { width: FRAME, height: FRAME, position: "relative", alignItems: "center", justifyContent: "flex-end" }, scanFrameIdle: { opacity: .55 }, corner: { position: "absolute", width: 28, height: 28, borderColor: "#fff" }, cornerIdle: { borderColor: "rgba(255,255,255,.55)" }, cornerTL: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4 }, cornerTR: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4 }, cornerBL: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4 }, cornerBR: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4 }, scanHint: { color: "rgba(255,255,255,.9)", marginBottom: -42, textAlign: "center" }, scanControls: { position: "absolute", left: 20, right: 20, bottom: 0, alignItems: "center", gap: 9 }, scanButton: { minWidth: 190, minHeight: 54, borderRadius: 27, paddingHorizontal: 24, backgroundColor: colors.light.primary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, shadowColor: "#000", shadowOpacity: .3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 6 }, scanButtonArmed: { backgroundColor: "#b42318" }, scanButtonText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" }, scanStatus: { color: "rgba(255,255,255,.88)", fontSize: 12, textAlign: "center", textShadowColor: "rgba(0,0,0,.8)", textShadowRadius: 3 }, modalBackdrop: { flex: 1, justifyContent: "flex-end" }, sheet: { maxHeight: "95%", minHeight: 360, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 8 }, handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: "#D1D5DB", alignSelf: "center", marginBottom: 16 }, header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 18 }, icon: { width: 46, height: 46, borderRadius: 12, alignItems: "center", justifyContent: "center" }, headerText: { flex: 1 }, title: { fontSize: 17, fontFamily: "Inter_600SemiBold" }, subtitle: { fontSize: 12, marginTop: 2 }, section: { marginBottom: 16 }, label: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: .7, marginBottom: 7 }, dropdownButton: { minHeight: 56, borderWidth: 1, borderRadius: 12, padding: 11, flexDirection: "row", alignItems: "center" }, dropdownText: { flex: 1 }, dropdownPrimary: { fontSize: 14, fontFamily: "Inter_600SemiBold" }, dropdownSecondary: { fontSize: 11, marginTop: 2 }, dropdownMenu: { borderWidth: 1, borderRadius: 12, marginTop: 5, overflow: "hidden" }, dropdownSearch: { margin: 8, height: 40, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10 }, dropdownScroll: { maxHeight: 190 }, dropdownOption: { minHeight: 52, padding: 10, justifyContent: "center" }, emptyText: { padding: 14, textAlign: "center" }, workflowWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, workflowButton: { flexGrow: 1, minWidth: "30%", minHeight: 46, borderWidth: 1, borderRadius: 12, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 }, workflowText: { fontSize: 12, fontFamily: "Inter_600SemiBold", textAlign: "center" }, exceptionToggle: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 }, exceptionText: { fontSize: 13 }, twoColumns: { flexDirection: "row", gap: 10, marginBottom: 16 }, flexField: { flex: 1 }, input: { minHeight: 44, borderWidth: 1, borderRadius: 11, paddingHorizontal: 10 }, stepper: { flexDirection: "row", gap: 12, alignItems: "center" }, stepButton: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" }, quantityInput: { flex: 1, height: 44, borderWidth: 1, borderRadius: 12, textAlign: "center", fontSize: 22, fontFamily: "Inter_600SemiBold" }, submitButton: { height: 52, borderRadius: 14, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", marginBottom: 8 }, submitText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" }, warning: { color: "#8a5a00", backgroundColor: "#fff4cf", borderRadius: 10, padding: 10, marginBottom: 12, fontSize: 12 }, error: { color: "#b42318", backgroundColor: "#fee4e2", borderRadius: 10, padding: 10, marginBottom: 12, fontSize: 12 }, feedback: { minHeight: 260, alignItems: "center", justifyContent: "center", gap: 14 }, feedbackText: { fontSize: 15, textAlign: "center" }, permissionContainer: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 32 }, permissionTitle: { fontSize: 22, fontFamily: "Inter_700Bold", marginTop: 16 }, permissionText: { fontSize: 15, textAlign: "center" }, permissionBtn: { marginTop: 8, paddingHorizontal: 32, paddingVertical: 14, borderRadius: 14 }, permissionBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" }, webFallback: { alignItems: "center", justifyContent: "center", backgroundColor: "#111", gap: 16 }, webText: { color: "#fff" }, webButton: { borderWidth: 1, borderColor: "#fff", borderRadius: 10, padding: 12 },
});
