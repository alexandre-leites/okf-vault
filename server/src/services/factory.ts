import type { Database } from "../db/client.js";
import type { Config } from "../config.js";
import { BundleRepository } from "../repository/bundle-repository.js";
import { ConceptRepository } from "../repository/concept-repository.js";
import { BundleService } from "./bundle-service.js";
import { ConceptService } from "./concept-service.js";
import { SearchService } from "./search-service.js";
import { IndexService } from "./index-service.js";
import { BundleExportService } from "./bundle-export.js";
import { BundleImportService } from "./bundle-import.js";
import { FsSyncService } from "./fs-sync-service.js";

export interface Services {
  readonly bundleRepo: BundleRepository;
  readonly conceptRepo: ConceptRepository;
  readonly bundleService: BundleService;
  readonly conceptService: ConceptService;
  readonly searchService: SearchService;
  readonly indexService: IndexService;
  readonly exportService: BundleExportService;
  readonly importService: BundleImportService;
  readonly fsSyncService: FsSyncService | undefined;
}

export function createServices(db: Database, config?: Config): Services {
  const bundleRepo = new BundleRepository(db);
  const conceptRepo = new ConceptRepository(db);

  let fsSync: FsSyncService | undefined;
  if (config?.BUNDLE_STORAGE_ENABLED && config?.BUNDLE_STORAGE_PATH) {
    fsSync = new FsSyncService(
      config.BUNDLE_STORAGE_PATH,
      bundleRepo,
      conceptRepo,
      new IndexService(bundleRepo, conceptRepo, null as unknown as BundleService),
    );
  }

  const bundleService = new BundleService(bundleRepo, conceptRepo, fsSync);
  const conceptService = new ConceptService(conceptRepo, bundleService, fsSync);

  // Re-create IndexService with the real bundleService now available
  const indexService = new IndexService(bundleRepo, conceptRepo, bundleService);
  const searchService = new SearchService(conceptRepo, bundleRepo, bundleService);
  const exportService = new BundleExportService(bundleRepo, conceptRepo);
  const importService = new BundleImportService(conceptService);

  // If storage is enabled, re-create FsSyncService with the real IndexService
  if (fsSync) {
    fsSync = new FsSyncService(config!.BUNDLE_STORAGE_PATH, bundleRepo, conceptRepo, indexService);
  }

  return {
    bundleRepo,
    conceptRepo,
    bundleService,
    conceptService,
    searchService,
    indexService,
    exportService,
    importService,
    fsSyncService: fsSync,
  };
}
