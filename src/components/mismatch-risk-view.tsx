"use client";

import {
  Chip,
  formatV2Usd,
  Surface,
  V2_TONE_TEXT,
  type V2Tone,
} from "@/components/v2-ui";
import {
  formatRiskAge,
  formatRiskProbability,
  getMismatchModelDisplayState,
  selectHighestRiskEstimate,
  type MismatchModelDisplayState,
} from "@/lib/mismatch-risk-display";
import type { GlobalRiskConfig } from "@/lib/risk-settings";
import type {
  LiveOpportunity,
  MismatchRiskEstimate,
  MismatchRiskMode,
  OrderIntent,
} from "@/lib/types";

export function AssetMismatchRiskOverview({
  mode,
  opportunities,
  globalConfig,
  globalConfigError,
  globalConfigLoading,
}: {
  mode: MismatchRiskMode;
  opportunities: LiveOpportunity[];
  globalConfig: GlobalRiskConfig | null;
  globalConfigError: string | null;
  globalConfigLoading?: boolean;
}) {
  const estimate = selectHighestRiskEstimate(opportunities);
  const modelState = getMismatchModelDisplayState(estimate);

  return (
    <div className="grid gap-3 xl:grid-cols-[1.15fr_0.85fr]">
      <Surface>
        <RiskPanelHeader
          title="Estimation du créneau"
          mode={mode}
          modelState={modelState}
        />
        <div className="grid grid-cols-2 gap-px bg-[var(--wa-gold-border)] md:grid-cols-4">
          <RiskMetric
            label="P fatal 95%"
            value={formatRiskProbability(estimate?.pFatalUpper95)}
            tone={probabilityTone(
              estimate?.pFatalUpper95,
              estimate?.maximumAllowedFatalProbability,
              modelState,
            )}
          />
          <RiskMetric
            label="Limite modèle"
            value={formatRiskProbability(estimate?.maximumAllowedFatalProbability)}
          />
          <RiskMetric
            label="P&L conservateur"
            value={formatSignedUsd(estimate?.conservativePnlUsd)}
            tone={pnlTone(estimate?.conservativePnlUsd)}
          />
          <RiskMetric
            label="P&L mismatch fatal"
            value={formatSignedUsd(estimate?.fatalPnlUsd)}
            tone={pnlTone(estimate?.fatalPnlUsd)}
          />
        </div>
        <RiskEstimateFooter estimate={estimate} />
      </Surface>

      <GlobalRiskBudgetPanel
        config={globalConfig}
        error={globalConfigError}
        loading={globalConfigLoading}
        compact
      />
    </div>
  );
}

export function GlobalRiskBudgetPanel({
  config,
  error,
  loading = false,
  compact = false,
}: {
  config: GlobalRiskConfig | null;
  error: string | null;
  loading?: boolean;
  compact?: boolean;
}) {
  return (
    <Surface>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--wa-gold-border)] px-5 py-4">
        <div>
          <div className="text-[9px] uppercase tracking-[0.22em] text-[rgba(201,168,100,0.45)]">
            Budget fatal global
          </div>
          <div className="mt-1 text-xs text-[var(--wa-mist)]">
            Cluster multi-actifs et fraîcheur d’exécution
          </div>
        </div>
        <Chip tone={config ? "emerald" : loading ? "amber" : "rose"}>
          {config ? "chargé" : loading ? "chargement" : "indisponible"}
        </Chip>
      </div>
      <div className={`grid grid-cols-2 gap-px bg-[var(--wa-gold-border)] ${compact ? "md:grid-cols-3" : "md:grid-cols-3 xl:grid-cols-6"}`}>
        <RiskMetric label="Part attendue" value={formatRiskProbability(config?.clusterExpectedFatalLossShare)} />
        <RiskMetric label="Cap attendu" value={formatV2Usd(config?.clusterExpectedFatalLossCapUsd)} />
        <RiskMetric label="Part absolue" value={formatRiskProbability(config?.clusterAbsoluteFatalLossShare)} />
        <RiskMetric label="Cap absolu" value={formatV2Usd(config?.clusterAbsoluteFatalLossCapUsd)} />
        <RiskMetric label="Âge balance max" value={formatRiskAge(config?.balanceMaxAgeMs)} />
        <RiskMetric label="Âge oracle max" value={formatRiskAge(config?.oracleMaxAgeMs)} />
      </div>
      {error ? (
        <div className="border-t border-[rgba(232,80,106,0.18)] bg-[rgba(232,80,106,0.06)] px-5 py-3 text-[11px] text-[var(--wa-rose)]">
          {error}
        </div>
      ) : null}
    </Surface>
  );
}

export function OpportunityMismatchRiskDetails({
  opportunity,
}: {
  opportunity: LiveOpportunity;
}) {
  const estimate = opportunity.mismatchRiskEstimate ?? null;
  const modelState = getMismatchModelDisplayState(estimate);

  return (
    <div className="border-t border-[var(--wa-gold-border)]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
        <span className="text-[9px] uppercase tracking-[0.20em] text-[rgba(201,168,100,0.45)]">
          Modèle probabiliste
        </span>
        <Chip tone={modelStateTone(modelState)}>{modelState}</Chip>
      </div>
      <div className="grid grid-cols-2 gap-px bg-[var(--wa-gold-border)] sm:grid-cols-4">
        <RiskMetric label="P fatal" value={formatRiskProbability(estimate?.pFatal)} />
        <RiskMetric
          label="P fatal 95%"
          value={formatRiskProbability(estimate?.pFatalUpper95)}
          tone={probabilityTone(
            estimate?.pFatalUpper95,
            estimate?.maximumAllowedFatalProbability,
            modelState,
          )}
        />
        <RiskMetric label="P alignée" value={formatRiskProbability(estimate?.pAligned)} />
        <RiskMetric label="P double payout" value={formatRiskProbability(estimate?.pDouble)} />
        <RiskMetric label="P seuil rentabilité" value={formatRiskProbability(estimate?.breakEvenFatalProbability)} />
        <RiskMetric label="P limite" value={formatRiskProbability(estimate?.maximumAllowedFatalProbability)} />
        <RiskMetric
          label="P&L conservateur"
          value={formatSignedUsd(estimate?.conservativePnlUsd)}
          tone={pnlTone(estimate?.conservativePnlUsd)}
        />
        <RiskMetric
          label="P&L fatal"
          value={formatSignedUsd(estimate?.fatalPnlUsd)}
          tone={pnlTone(estimate?.fatalPnlUsd)}
        />
      </div>
      <RiskEstimateFooter estimate={estimate} />
    </div>
  );
}

export function IntentMismatchRiskDetails({ intent }: { intent: OrderIntent }) {
  const hasRiskData =
    (intent.mismatchPFatal !== null && intent.mismatchPFatal !== undefined) ||
    (intent.mismatchPFatalUpper !== null && intent.mismatchPFatalUpper !== undefined) ||
    (intent.conservativeExpectedPnlUsd !== null && intent.conservativeExpectedPnlUsd !== undefined) ||
    (intent.fatalLossExposureUsd !== null && intent.fatalLossExposureUsd !== undefined);

  if (!hasRiskData) {
    return null;
  }

  return (
    <div className="mt-3 overflow-hidden border-y border-[var(--wa-gold-border)]">
      <div className="grid grid-cols-2 gap-px bg-[var(--wa-gold-border)] sm:grid-cols-4">
        <RiskMetric label="P fatal" value={formatRiskProbability(intent.mismatchPFatal)} />
        <RiskMetric label="P fatal 95%" value={formatRiskProbability(intent.mismatchPFatalUpper)} />
        <RiskMetric
          label="P&L conservateur"
          value={formatSignedUsd(intent.conservativeExpectedPnlUsd)}
          tone={pnlTone(intent.conservativeExpectedPnlUsd)}
        />
        <RiskMetric
          label="Exposition fatale"
          value={formatV2Usd(intent.fatalLossExposureUsd)}
          tone="rose"
        />
      </div>
      {intent.mismatchModelVersion ? (
        <div className="bg-[var(--wa-bg0)] px-3 py-2 font-mono text-[9px] text-[var(--wa-dim)]">
          {intent.mismatchModelVersion}
        </div>
      ) : null}
    </div>
  );
}

function RiskPanelHeader({
  title,
  mode,
  modelState,
}: {
  title: string;
  mode: MismatchRiskMode;
  modelState: MismatchModelDisplayState;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--wa-gold-border)] px-5 py-4">
      <div>
        <div className="text-[9px] uppercase tracking-[0.22em] text-[rgba(201,168,100,0.45)]">{title}</div>
        <div className="mt-1 font-mono text-[10px] text-[var(--wa-dim)]">guard {mode}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Chip tone={modeTone(mode)}>{mode}</Chip>
        <Chip tone={modelStateTone(modelState)}>{modelState}</Chip>
      </div>
    </div>
  );
}

function RiskEstimateFooter({ estimate }: { estimate: MismatchRiskEstimate | null }) {
  const modelState = getMismatchModelDisplayState(estimate);
  const details = estimate
    ? `${estimate.observationCount} obs · Chainlink ${formatRiskAge(estimate.chainlinkAgeMs)} · CF ${formatRiskAge(estimate.cfAgeMs)}`
    : "Aucune estimation pour le créneau";

  return (
    <div className="border-t border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-5 py-3">
      <div className="flex flex-col gap-1 font-mono text-[9px] text-[var(--wa-dim)] sm:flex-row sm:items-center sm:justify-between">
        <span className="break-all">{estimate?.modelVersion ?? "model --"}</span>
        <span>{details}</span>
      </div>
      {estimate?.reason ? (
        <div className={`mt-2 text-[10px] ${modelState === "calibrated" ? V2_TONE_TEXT.mist : V2_TONE_TEXT.amber}`}>
          {estimate.reason}
        </div>
      ) : null}
    </div>
  );
}

function RiskMetric({
  label,
  value,
  tone = "mist",
}: {
  label: string;
  value: string;
  tone?: V2Tone;
}) {
  return (
    <div className="min-w-0 bg-[var(--wa-bg1)] px-3 py-3">
      <div className="mb-1 text-[8px] uppercase tracking-[0.14em] text-[var(--wa-dim)]">{label}</div>
      <div className={`break-words font-mono text-xs ${V2_TONE_TEXT[tone]}`}>{value}</div>
    </div>
  );
}

function modelStateTone(state: MismatchModelDisplayState): V2Tone {
  return state === "calibrated" ? "emerald" : state === "uncalibrated" ? "amber" : "rose";
}

function modeTone(mode: MismatchRiskMode): V2Tone {
  return mode === "enforce" ? "rose" : mode === "block_only" ? "amber" : "indigo";
}

function probabilityTone(
  value: number | null | undefined,
  limit: number | null | undefined,
  modelState: MismatchModelDisplayState,
): V2Tone {
  if (modelState === "uncalibrated") {
    return "amber";
  }
  if (modelState === "unavailable") {
    return "mist";
  }
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "mist";
  }
  if (limit !== null && limit !== undefined && Number.isFinite(limit)) {
    return value <= limit ? "emerald" : "rose";
  }
  return "amber";
}

function pnlTone(value: number | null | undefined): V2Tone {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "mist";
  }
  return value >= 0 ? "emerald" : "rose";
}

function formatSignedUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return `${value >= 0 ? "+" : "-"}${formatV2Usd(Math.abs(value))}`;
}
