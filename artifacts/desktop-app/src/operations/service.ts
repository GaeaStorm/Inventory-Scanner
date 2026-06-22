import type { ApplicationDatabase } from "../database/application-database";
import type { StoresService } from "../stores/service";
import type { PlanningService } from "../planning/service";
import type {
  ActorContext,
  BootstrapAdminInput,
  ConditionTransitionInput,
  CreateCountSessionInput,
  CreateFaultInput,
  CustomerReturnInput,
  FinalizeCountInput,
  ForgotCredentialInput,
  LoginInput,
  Permission,
  ProductionCompletionInput,
  ProductionIssueInput,
  ProductionReturnInput,
  ReceiveCustomerReturnInput,
  RecordCountEntryInput,
  ResetCredentialInput,
  ResolveFaultInput,
  ResolveSyncExceptionInput,
  ReverseMovementInput,
  SaveUserInput,
  ScrapInput,
  SupplierReturnInput,
  UpdateSupplierReturnInput,
} from "./types";
import { requirePermission } from "./permissions";
import { OperationsDatabase } from "./database";

export class OperationsService {
  readonly database: OperationsDatabase;
  private readonly stores: StoresService;
  private planning: PlanningService | null = null;

  constructor(host: ApplicationDatabase, stores: StoresService) {
    this.stores = stores;
    this.database = new OperationsDatabase(host, () => stores.backup("before-operations-migration"));
    this.database.reconcileLegacyLots();
  }

  bindPlanning(planning: PlanningService): void {
    this.planning = planning;
  }

  actorForToken(token: string): ActorContext | null {
    return this.database.actorForToken(token);
  }

  requireActor(token: string, permission?: Permission): ActorContext {
    const actor = this.actorForToken(token);
    if (!actor) throw new Error("Sign in before performing this operation.");
    return permission ? requirePermission(actor, permission) : actor;
  }

  bootstrapAdmin(input: BootstrapAdminInput) {
    return this.database.bootstrapAdmin(input);
  }

  login(input: LoginInput) {
    return this.database.login(input);
  }

  forgotCredential(input: ForgotCredentialInput) {
    return this.database.forgotCredential(input);
  }

  updateOwnEmail(input: { email: string }, actor: ActorContext) {
    return this.database.updateOwnEmail(input, actor);
  }

  sharedPhoneActor() {
    return this.database.sharedPhoneActor();
  }

  resume(token: string) {
    return this.database.resume(token);
  }

  logout(token: string) {
    this.database.logout(token);
  }

  authState(token?: string) {
    return this.database.authState(token ? this.actorForToken(token) : null);
  }

  saveUser(input: SaveUserInput, actor: ActorContext) {
    return this.database.saveUser(input, actor);
  }

  resetCredential(input: ResetCredentialInput, actor: ActorContext) {
    return this.database.resetCredential(input, actor);
  }

  getState(actor: ActorContext) {
    requirePermission(actor, "INVENTORY_VIEW");
    return this.database.getState();
  }

  transitionCondition(input: ConditionTransitionInput, actor: ActorContext) {
    return this.database.transitionCondition(input, actor);
  }

  createFault(input: CreateFaultInput, actor: ActorContext) {
    return this.database.createFault(input, actor);
  }

  resolveFault(input: ResolveFaultInput, actor: ActorContext) {
    return this.database.resolveFault(input, actor);
  }

  createCountSession(input: CreateCountSessionInput, actor: ActorContext) {
    return this.database.createCountSession(input, actor);
  }

  recordCountEntry(input: RecordCountEntryInput, actor: ActorContext) {
    return this.database.recordCountEntry(input, actor);
  }

  finalizeCount(input: FinalizeCountInput, actor: ActorContext) {
    return this.database.finalizeCount(input, actor);
  }

  productionReturn(input: ProductionReturnInput, actor: ActorContext) {
    return this.database.productionReturn(input, actor);
  }

  supplierReturn(input: SupplierReturnInput, actor: ActorContext) {
    return this.database.supplierReturn(input, actor);
  }

  updateSupplierReturn(input: UpdateSupplierReturnInput, actor: ActorContext) {
    return this.database.updateSupplierReturn(input, actor);
  }

  initiateCustomerReturn(input: CustomerReturnInput, actor: ActorContext) {
    return this.database.initiateCustomerReturn(input, actor);
  }

  receiveCustomerReturn(input: ReceiveCustomerReturnInput, actor: ActorContext) {
    return this.database.receiveCustomerReturn(input, actor);
  }

  scrap(input: ScrapInput, actor: ActorContext) {
    return this.database.scrap(input, actor);
  }

  releaseProductOrder(input: { clientTransactionId: string; productOrderId: string; notes?: string }, actor: ActorContext) {
    return this.database.releaseProductOrder(input.productOrderId, input.clientTransactionId, input.notes ?? "", actor);
  }

  setProductOrderExecutionStatus(
    input: { clientTransactionId: string; productOrderId: string; status: "CANCELLED" | "CLOSED"; notes?: string },
    actor: ActorContext,
  ) {
    const result = this.database.setProductionOrderExecutionStatus(
      input.productOrderId,
      input.status,
      input.clientTransactionId,
      input.notes ?? "",
      actor,
    );
    if (this.planning) {
      this.planning.updateProductOrderStatus(
        input.productOrderId,
        input.status === "CANCELLED" ? "CANCELLED" : "COMPLETED",
        actor,
      );
    }
    return result;
  }

  issueProductionMaterial(input: ProductionIssueInput, actor: ActorContext) {
    requirePermission(actor, "PRODUCTION_EXECUTE");
    return this.stores.materialOut({
      clientTransactionId: input.clientTransactionId,
      boxId: input.boxId ?? "",
      tallyItemGuid: input.tallyItemGuid,
      purpose: "PRODUCTION",
      destinationTallyItemGuid: input.destinationTallyItemGuid,
      quantity: input.quantity,
      eventDate: input.eventDate,
      productOrderId: input.productOrderId,
      substitutionForTallyGuid: input.substitutionForTallyGuid,
      additionalConsumption: input.additionalConsumption,
      notes: input.notes,
      serialNumbers: input.serialNumbers,
    }, actor);
  }

  productionCompletion(input: ProductionCompletionInput, actor: ActorContext) {
    return this.database.productionCompletion(input, actor);
  }

  reverseMovement(input: ReverseMovementInput, actor: ActorContext) {
    return this.database.reverseMovement(input, actor);
  }

  reviewManualTally(input: any, actor: ActorContext) {
    return this.database.reviewManualTally(input, actor);
  }

  recordSyncException(input: Parameters<OperationsDatabase["recordSyncException"]>[0]) {
    return this.database.recordSyncException(input);
  }

  resolveSyncException(input: ResolveSyncExceptionInput, actor: ActorContext) {
    requirePermission(actor, "SYNC_EXCEPTION_RESOLVE");
    const state = this.database.getState();
    const exception = state.syncExceptions.find((entry) => entry.id === input.exceptionId);
    if (!exception) throw new Error("Synchronization exception not found.");
    if (exception.status !== "OPEN") throw new Error("This synchronization exception is already resolved.");
    const payload = (input.correctedPayload ?? exception.originalPayload) as any;

    if (input.action === "CANCEL") {
      return this.database.markSyncException(exception.id, "CANCELLED", input.action, input.notes ?? "", actor, input.expectedVersion);
    }
    if (input.action === "AUTHORIZED_SHORTAGE") {
      this.database.recordAuthorizedShortage(
        exception,
        `${input.clientTransactionId}:authorized-shortage`,
        input.notes || "Authorized inventory shortage recorded without creating a negative physical balance.",
        actor,
      );
      return this.database.markSyncException(
        exception.id,
        "RESOLVED",
        input.action,
        input.notes || "Authorized inventory shortage recorded without creating a negative physical balance.",
        actor,
        input.expectedVersion,
      );
    }

    const operationType = exception.operationType;
    const nextId = `${input.clientTransactionId}:applied`;
    const applyPayload = { ...payload, clientTransactionId: nextId };
    if (input.action === "REDUCE_TO_AVAILABLE") {
      if (operationType !== "MATERIAL_OUT") throw new Error("Reduce-to-available is only supported for Material Out exceptions.");
      const available = Math.max(0, exception.availableQuantity);
      if (available > 0) {
        this.stores.materialOut({ ...applyPayload, quantity: Math.min(Number(payload.quantity ?? 0), available) }, actor);
      }
      const remainder = Math.max(0, Number(payload.quantity ?? 0) - available);
      if (remainder > 0) {
        this.database.recordSyncException({
          clientTransactionId: `${exception.clientTransactionId}:remainder`,
          deviceId: exception.deviceId,
          operator: exception.operator,
          localTimestamp: exception.localTimestamp,
          operationType,
          tallyItemGuid: exception.tallyItemGuid,
          requestedQuantity: remainder,
          productOrderId: exception.productOrderId,
          reason: "Remainder after reducing the transaction to available quantity.",
          payload: { ...payload, quantity: remainder },
        });
      }
      return this.database.markSyncException(exception.id, "RESOLVED", input.action, input.notes ?? "", actor, input.expectedVersion);
    }

    if (operationType === "MATERIAL_OUT") this.stores.materialOut(applyPayload, actor);
    else if (operationType === "ADJUSTMENT") this.stores.adjustment(applyPayload, actor);
    else throw new Error("This exception type cannot be retried automatically. Replace it with a corrected transaction.");

    return this.database.markSyncException(
      exception.id,
      input.action === "REPLACE_WITH_CORRECTED" ? "REPLACED" : "RESOLVED",
      input.action,
      input.notes ?? "",
      actor,
      input.expectedVersion,
    );
  }
}
