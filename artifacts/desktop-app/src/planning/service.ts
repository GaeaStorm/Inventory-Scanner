import type { ApplicationDatabase } from "../database/application-database";
import type { StoresService } from "../stores/service";
import type { ActorContext } from "../operations/types";
import { requirePermission } from "../operations/permissions";
import { PlanningDatabase } from "./database";
import { PlanningExporter } from "./exporter";
import type {
  PlanningExportInput,
  RecommendationDecisionInput,
  RestockPolicyInput,
  SaveBomInput,
  SaveProductOrderFieldDefinitionInput,
  SaveProductOrderInput,
  SaveProductOrderWorkflowStateInput,
} from "./types";

export class PlanningService {
  readonly database: PlanningDatabase;
  readonly exporter: PlanningExporter;

  constructor(
    databaseHost: ApplicationDatabase,
    stores: StoresService,
  ) {
    this.database = new PlanningDatabase(
      databaseHost,
      () => { stores.backup("before-planning-migration"); },
    );
    this.exporter = new PlanningExporter(this.database, stores.database);
  }

  getState(actor?: ActorContext) {
    if (actor) requirePermission(actor, "RESTOCK_VIEW");
    return this.database.getState();
  }

  resetForCatalogReplacement(actor?: ActorContext) {
    if (actor) requirePermission(actor, "CATALOG_MANAGE");
    this.database.resetForCatalogReplacement();
  }

  saveRestockPolicy(input: RestockPolicyInput, actor: ActorContext) {
    requirePermission(actor, "RESTOCK_MANAGE");
    this.database.saveRestockPolicy(input);
    return this.getState();
  }

  decideRecommendation(input: RecommendationDecisionInput, actor: ActorContext) {
    requirePermission(actor, "RESTOCK_MANAGE");
    this.database.decideRecommendation(input);
    return this.getState();
  }

  saveBom(input: SaveBomInput, actor: ActorContext) {
    requirePermission(actor, "BOM_MANAGE");
    this.database.saveBom(input);
    return this.getState();
  }

  activateBom(bomId: string, actor: ActorContext) {
    requirePermission(actor, "BOM_MANAGE");
    this.database.activateBom(bomId);
    return this.getState();
  }

  saveProductOrder(input: SaveProductOrderInput, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.saveProductOrder(input);
    return this.getState();
  }

  updateProductOrderStatus(orderId: string, status: "CANCELLED" | "COMPLETED" | "CONFIRMED", actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.updateProductOrderStatus(orderId, status);
    return this.getState();
  }

  updateProductOrderWorkflowState(orderId: string, workflowStateId: string, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.updateProductOrderWorkflowState(orderId, workflowStateId);
    return this.getState();
  }

  saveProductOrderWorkflowState(input: SaveProductOrderWorkflowStateInput, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.saveProductOrderWorkflowState(input);
    return this.getState();
  }

  deleteProductOrderWorkflowState(stateId: string, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.deleteProductOrderWorkflowState(stateId);
    return this.getState();
  }

  saveProductOrderFieldDefinition(input: SaveProductOrderFieldDefinitionInput, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.saveProductOrderFieldDefinition(input);
    return this.getState();
  }

  deleteProductOrderFieldDefinition(fieldId: string, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.deleteProductOrderFieldDefinition(fieldId);
    return this.getState();
  }

  exportRestock(input: PlanningExportInput, actor: ActorContext) {
    requirePermission(actor, "RESTOCK_MANAGE");
    return this.exporter.generate(input);
  }
}
