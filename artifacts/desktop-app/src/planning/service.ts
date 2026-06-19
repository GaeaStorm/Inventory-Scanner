import type { ApplicationDatabase } from "../database/application-database";
import type { StoresService } from "../stores/service";
import { PlanningDatabase } from "./database";
import { PlanningExporter } from "./exporter";
import type {
  PlanningExportInput,
  RecommendationDecisionInput,
  RestockPolicyInput,
  SaveBomInput,
  SaveProductOrderInput,
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

  getState() {
    return this.database.getState();
  }

  resetForCatalogReplacement() {
    this.database.resetForCatalogReplacement();
  }

  saveRestockPolicy(input: RestockPolicyInput) {
    this.database.saveRestockPolicy(input);
    return this.getState();
  }

  decideRecommendation(input: RecommendationDecisionInput) {
    this.database.decideRecommendation(input);
    return this.getState();
  }

  saveBom(input: SaveBomInput) {
    this.database.saveBom(input);
    return this.getState();
  }

  activateBom(bomId: string) {
    this.database.activateBom(bomId);
    return this.getState();
  }

  saveProductOrder(input: SaveProductOrderInput) {
    this.database.saveProductOrder(input);
    return this.getState();
  }

  updateProductOrderStatus(orderId: string, status: "CANCELLED" | "COMPLETED" | "CONFIRMED") {
    this.database.updateProductOrderStatus(orderId, status);
    return this.getState();
  }

  exportRestock(input: PlanningExportInput) {
    return this.exporter.generate(input);
  }
}
