import type { Database } from "../db/client.js";
import { BundleRepository } from "../repository/bundle-repository.js";
import { ConceptRepository } from "../repository/concept-repository.js";
import { BundleService } from "./bundle-service.js";
import { ConceptService } from "./concept-service.js";
import { SearchService } from "./search-service.js";
import { IndexService } from "./index-service.js";
import { BundleExportService } from "./bundle-export.js";
import { BundleImportService } from "./bundle-import.js";

export interface Services {
  readonly bundleRepo: BundleRepository;
  readonly conceptRepo: ConceptRepository;
  readonly bundleService: BundleService;
  readonly conceptService: ConceptService;
  readonly searchService: SearchService;
  readonly indexService: IndexService;
  readonly exportService: BundleExportService;
  readonly importService: BundleImportService;
}

export function createServices(db: Database): Services {
  const bundleRepo = new BundleRepository(db);
  const conceptRepo = new ConceptRepository(db);
  const bundleService = new BundleService(bundleRepo, conceptRepo);
  const conceptService = new ConceptService(conceptRepo, bundleService);
  const searchService = new SearchService(conceptRepo, bundleRepo, bundleService);
  const indexService = new IndexService(bundleRepo, conceptRepo, bundleService);
  const exportService = new BundleExportService(bundleRepo, conceptRepo);
  const importService = new BundleImportService(conceptService);
  return {
    bundleRepo,
    conceptRepo,
    bundleService,
    conceptService,
    searchService,
    indexService,
    exportService,
    importService,
  };
}
