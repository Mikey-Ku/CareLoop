import { z } from "zod";

// Wire types for FinchNode's normalized /users/{subject}/records snapshot.
// Loose objects: FinchNode adds fields over time and we only rely on these.

export const CATEGORIES = [
  "demographics",
  "medications",
  "conditions",
  "labs",
  "vitals",
  "allergies",
  "immunizations",
  "encounters",
  "documents",
  "claims",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CodeSchema = z.looseObject({
  system: z.string(),
  code: z.string(),
  display: z.string().nullish(),
});
export type Code = z.infer<typeof CodeSchema>;

const RecordBase = z.looseObject({
  id: z.string(),
  resourceType: z.string(),
  sourceRecordId: z.string().nullish(),
  source: z.string(),
  sourceName: z.string().nullish(),
  codes: z.array(CodeSchema).nullish().transform((c) => c ?? []),
  sourceUpdatedAt: z.string().nullish(),
  syncedAt: z.string().nullish(),
});

export const DemographicsSchema = RecordBase.extend({
  name: z.string().nullish(),
  birthDate: z.string().nullish(),
  gender: z.string().nullish(),
});
export type WireDemographics = z.infer<typeof DemographicsSchema>;

export const MedicationSchema = RecordBase.extend({
  name: z.string().nullish(),
  dosage: z.string().nullish(),
  status: z.string().nullish(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
});
export type WireMedication = z.infer<typeof MedicationSchema>;

export const DispenseSchema = RecordBase.extend({
  name: z.string().nullish(),
  status: z.string().nullish(),
  quantity: z.coerce.number().nullish(),
  quantityUnit: z.string().nullish(),
  daysSupply: z.coerce.number().nullish(),
  handedOverDate: z.string().nullish(),
});
export type WireDispense = z.infer<typeof DispenseSchema>;

export const ObservationSchema = RecordBase.extend({
  name: z.string().nullish(),
  value: z.union([z.string(), z.number()]).nullish(),
  unit: z.string().nullish(),
  status: z.string().nullish(),
  date: z.string().nullish(),
  referenceRange: z.string().nullish(),
  interpretation: z.string().nullish(),
});
export type WireObservation = z.infer<typeof ObservationSchema>;

export const ConditionSchema = RecordBase.extend({
  name: z.string().nullish(),
  status: z.string().nullish(),
  onsetDate: z.string().nullish(),
  recordedDate: z.string().nullish(),
});
export type WireCondition = z.infer<typeof ConditionSchema>;

const list = <T extends z.ZodType>(item: T) => z.array(item).nullish().transform((v) => v ?? []);

export const WarningSchema = z.looseObject({
  code: z.string(),
  message: z.string().nullish(),
  source: z.string().nullish(),
  category: z.string().nullish(),
  retryable: z.boolean().nullish(),
});
export type Warning = z.infer<typeof WarningSchema>;

export const HealthRecordSchema = z.looseObject({
  id: z.string(),
  object: z.literal("health_record"),
  categories: z.array(z.string()).default([]),
  consent: z
    .looseObject({
      status: z.string().nullish(),
      receipts: z
        .array(
          z.looseObject({
            id: z.string(),
            categories: z.array(z.string()),
            source: z.string().nullish(),
            expiresAt: z.string().nullish(),
          }),
        )
        .default([]),
    })
    .nullish(),
  sources: list(
    z.looseObject({
      system: z.string(),
      organization: z.string().nullish(),
      lastSyncedAt: z.string().nullish(),
    }),
  ),
  data: z.looseObject({
    demographics: DemographicsSchema.nullish(),
    medications: list(MedicationSchema),
    medicationDispenses: list(DispenseSchema),
    labs: list(ObservationSchema),
    vitals: list(ObservationSchema),
    conditions: list(ConditionSchema),
  }),
  meta: z.looseObject({
    syncStatus: z.string(),
    dataAsOf: z.string().nullish(),
    lastSuccessfulSyncAt: z.string().nullish(),
    availableCategories: z.array(z.string()).default([]),
    missingCategories: z.array(z.string()).default([]),
    warnings: list(WarningSchema),
    sources: list(
      z.looseObject({
        system: z.string(),
        status: z.string().nullish(),
        lastSuccessfulSyncAt: z.string().nullish(),
      }),
    ),
  }),
});
export type HealthRecord = z.infer<typeof HealthRecordSchema>;

export const ErrorBodySchema = z.looseObject({
  error: z.looseObject({
    type: z.string().nullish(),
    code: z.string(),
    message: z.string().nullish(),
    requestId: z.string().nullish(),
  }),
});

export const ScenarioListSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      kind: z.string(),
      subject: z.string().nullish(),
      behavior: z.string().nullish(),
      sessionOutcome: z.string().nullish(),
    }),
  ),
});
export type ScenarioList = z.infer<typeof ScenarioListSchema>;

// Demo and sandbox spell connect sessions differently; see docs "Moving to the sandbox".
export const ConnectSessionWireSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  patient_id: z.string().nullish(),
  subject: z.string().nullish(),
  failure_code: z.string().nullish(),
  failureCode: z.string().nullish(),
  connect_url: z.string().nullish(),
  url: z.string().nullish(),
});
