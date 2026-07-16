"use client";

import {
  Chip,
  formatV2Usd,
  Surface,
  V2_TONE_TEXT,
  type V2Tone,
} from "@/components/v2-ui";
import {
  classifySettledIntentMismatch,
  formatMismatchAuditDecision,
  formatMismatchAuditSettlementLabel,
  formatMismatchEconomicsBasis,
  formatMismatchSettlementClassification,
  formatRiskAge,
  formatRiskProbability,
  getMismatchModelDisplayState,
  isMismatchBlockingDecision,
  readIntentMismatchRiskAudit,
  readOpportunityMismatchEconomics,
  selectHighestRiskEstimate,
  type MismatchModelDisplayState,
  type MismatchSettlementClassification,
} from "@/lib/mismatch-risk-display";
import type { GlobalRiskConfig } from "@/lib/risk-settings";
import type {
  LiveOpportunity,
  MismatchEconomicsBasis,
  MismatchRiskAudit,
  MismatchRiskCounterfactualDecision,
  MismatchRiskEstimate,
  MismatchRiskMode,
  OrderIntent,
  PairCombination,
} from "@/lib/types";

const MISMATCH_COMBINATIONS: Array<{
  combination: PairCombination;
  label: string;
}> = [
  { combination: "POLY_UP_KALSHI_NO", label: "Poly UP + Kalshi NO" },
  { combination: "POLY_DOWN_KALSHI_YES", label: "Poly DOWN + Kalshi YES" },
];

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
          executionUsable={estimate?.executionUsable}
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

      <Surface className="xl:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--wa-gold-border)] px-5 py-4">
          <div>
            <div className="text-[9px] uppercase tracking-[0.22em] text-[rgba(201,168,100,0.45)]">
              Audit contre-factuel des deux combinaisons
            </div>
            <div className="mt-1 text-xs text-[var(--wa-mist)]">
              Verdict observé uniquement, sans modifier l’éligibilité live
            </div>
          </div>
          <Chip tone="amber">block_only</Chip>
        </div>
        {MISMATCH_COMBINATIONS.map(({ combination, label }, index) => (
          <OpportunityAuditRow
            key={combination}
            opportunity={opportunities.find((item) => item.combination === combination) ?? null}
            label={label}
            last={index === MISMATCH_COMBINATIONS.length - 1}
          />
        ))}
      </Surface>
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
  const audit = opportunity.mismatchRiskAudit ?? null;
  const economics = readOpportunityMismatchEconomics(opportunity);
  const modelState = getMismatchModelDisplayState(estimate);
  const auditModelState = getAuditModelState(audit, modelState);
  const pFatal = audit ? audit.pFatal : estimate?.pFatal;
  const pFatalUpper95 = audit ? audit.pFatalUpper95 : estimate?.pFatalUpper95;
  const breakEven = audit ? audit.breakEvenFatalProbability : estimate?.breakEvenFatalProbability;
  const limit = audit ? audit.maximumAllowedFatalProbability : estimate?.maximumAllowedFatalProbability;
  const conservativePnl = audit ? audit.conservativePnlUsd : estimate?.conservativePnlUsd;
  const fatalPnl = audit ? audit.fatalPnlUsd : estimate?.fatalPnlUsd;

  return (
    <div className="border-t border-[var(--wa-gold-border)]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
        <span className="text-[9px] uppercase tracking-[0.20em] text-[rgba(201,168,100,0.45)]">
          Modèle probabiliste
        </span>
        <div className="flex flex-wrap gap-2">
          {audit ? (
            <Chip tone={auditDecisionTone(audit.decision)}>
              block_only · {formatMismatchAuditDecision(audit.decision)}
            </Chip>
          ) : null}
          {economics ? (
            <Chip tone={economicsBasisTone(economics.basis)}>
              {formatMismatchEconomicsBasis(economics.basis)}
            </Chip>
          ) : null}
          <Chip tone={modelStateTone(modelState)}>{modelState}</Chip>
          {estimate?.available ? (
            <Chip tone={estimate.executionUsable === false ? "amber" : "emerald"}>
              {estimate.executionUsable === false ? "diagnostic" : "exec fresh"}
            </Chip>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px bg-[var(--wa-gold-border)] sm:grid-cols-5">
        <RiskMetric label="P fatal" value={formatRiskProbability(pFatal)} />
        <RiskMetric
          label="P fatal 95%"
          value={formatRiskProbability(pFatalUpper95)}
          tone={probabilityTone(
            pFatalUpper95,
            limit,
            auditModelState,
          )}
        />
        <RiskMetric label="P alignée" value={formatRiskProbability(estimate?.pAligned)} />
        <RiskMetric label="P double payout" value={formatRiskProbability(estimate?.pDouble)} />
        <RiskMetric label="P seuil rentabilité" value={formatRiskProbability(breakEven)} />
        <RiskMetric label="P limite" value={formatRiskProbability(limit)} />
        <RiskMetric
          label="P&L conservateur"
          value={formatSignedUsd(conservativePnl)}
          tone={pnlTone(conservativePnl)}
        />
        <RiskMetric
          label="P&L fatal"
          value={formatSignedUsd(fatalPnl)}
          tone={pnlTone(fatalPnl)}
        />
        <RiskMetric label="Taille économique" value={formatPairSize(economics?.pairSize)} />
        <RiskMetric label="Coût économique" value={formatV2Usd(economics?.totalCostUsd)} />
      </div>
      {audit ? <MismatchAuditReasons audit={audit} /> : null}
      <RiskEstimateFooter estimate={estimate} />
    </div>
  );
}

export function IntentMismatchRiskDetails({ intent }: { intent: OrderIntent }) {
  const audit = readIntentMismatchRiskAudit(intent);
  const settlement = classifySettledIntentMismatch(intent);
  const pFatal = audit ? audit.pFatal : intent.mismatchPFatal;
  const pFatalUpper95 = audit ? audit.pFatalUpper95 : intent.mismatchPFatalUpper;
  const conservativePnl = audit ? audit.conservativePnlUsd : intent.conservativeExpectedPnlUsd;
  const fatalPnl = audit ? audit.fatalPnlUsd : intent.fatalMismatchPnlUsd;
  const hasRiskData =
    audit !== null ||
    settlement !== null ||
    (intent.mismatchPFatal !== null && intent.mismatchPFatal !== undefined) ||
    (intent.mismatchPFatalUpper !== null && intent.mismatchPFatalUpper !== undefined) ||
    (intent.conservativeExpectedPnlUsd !== null && intent.conservativeExpectedPnlUsd !== undefined) ||
    (intent.fatalLossExposureUsd !== null && intent.fatalLossExposureUsd !== undefined);

  if (!hasRiskData) {
    return null;
  }

  return (
    <div className="mt-3 overflow-hidden border-y border-[var(--wa-gold-border)]">
      {audit || settlement ? (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--wa-bg0)] px-3 py-2">
          <div className="flex flex-wrap gap-2">
            {audit && settlement ? (
              <Chip tone={combinedOutcomeTone(audit.decision, settlement)}>
                {formatMismatchAuditSettlementLabel(audit.decision, settlement)}
              </Chip>
            ) : null}
            {audit ? (
              <>
                <Chip tone={auditDecisionTone(audit.decision)}>
                  {audit.source === "reconstructed"
                    ? "approx. reconstruit · "
                    : "block_only · "}
                  {formatMismatchAuditDecision(audit.decision)}
                </Chip>
                <Chip tone={economicsBasisTone(audit.economicsBasis)}>
                  {formatMismatchEconomicsBasis(audit.economicsBasis)}
                </Chip>
                <Chip tone={audit.enforceReady ? "emerald" : "amber"}>
                  risk enforce {audit.enforceReady ? "prêt" : "non prêt"}
                </Chip>
              </>
            ) : (
              <Chip tone="mist">audit absent</Chip>
            )}
            {settlement ? (
              <Chip tone={settlementTone(settlement)}>
                {formatMismatchSettlementClassification(settlement)}
              </Chip>
            ) : null}
          </div>
          {audit ? (
            <span className="font-mono text-[9px] text-[var(--wa-dim)]">
              {formatAuditSource(audit.source)} · {new Date(audit.evaluatedAt).toLocaleString("fr-FR")}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-px bg-[var(--wa-gold-border)] sm:grid-cols-4">
        <RiskMetric label="P fatal" value={formatRiskProbability(pFatal)} />
        <RiskMetric label="P fatal 95%" value={formatRiskProbability(pFatalUpper95)} />
        <RiskMetric label="P limite" value={formatRiskProbability(audit?.maximumAllowedFatalProbability)} />
        <RiskMetric
          label="P&L conservateur"
          value={formatSignedUsd(conservativePnl)}
          tone={pnlTone(conservativePnl)}
        />
        <RiskMetric
          label="Exposition fatale"
          value={formatV2Usd(intent.fatalLossExposureUsd)}
          tone="rose"
        />
        <RiskMetric label="Taille économique" value={formatPairSize(audit?.pairSize)} />
        <RiskMetric label="Coût économique" value={formatV2Usd(audit?.totalCostUsd)} />
        <RiskMetric label="P&L fatal" value={formatSignedUsd(fatalPnl)} tone={pnlTone(fatalPnl)} />
      </div>
      {audit ? <MismatchAuditReasons audit={audit} /> : null}
      {audit?.modelVersion || intent.mismatchModelVersion ? (
        <div className="bg-[var(--wa-bg0)] px-3 py-2 font-mono text-[9px] text-[var(--wa-dim)]">
          {audit?.modelVersion ?? intent.mismatchModelVersion}
        </div>
      ) : null}
    </div>
  );
}

function OpportunityAuditRow({
  opportunity,
  label,
  last,
}: {
  opportunity: LiveOpportunity | null;
  label: string;
  last: boolean;
}) {
  const audit = opportunity?.mismatchRiskAudit ?? null;
  const estimate = opportunity?.mismatchRiskEstimate ?? null;
  const economics = opportunity ? readOpportunityMismatchEconomics(opportunity) : null;
  const pFatalUpper95 = audit ? audit.pFatalUpper95 : estimate?.pFatalUpper95;
  const limit = audit ? audit.maximumAllowedFatalProbability : estimate?.maximumAllowedFatalProbability;
  const conservativePnl = audit ? audit.conservativePnlUsd : estimate?.conservativePnlUsd;
  const fatalPnl = audit ? audit.fatalPnlUsd : estimate?.fatalPnlUsd;
  const modelState = getAuditModelState(audit, getMismatchModelDisplayState(estimate));

  return (
    <div className={last ? "" : "border-b border-[var(--wa-gold-border)]"}>
      <div className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="font-mono text-xs text-[var(--wa-ivory)]">{label}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {audit ? (
              <Chip tone={auditDecisionTone(audit.decision)}>
                {formatMismatchAuditDecision(audit.decision)}
              </Chip>
            ) : (
              <Chip tone="mist">audit absent</Chip>
            )}
            {economics ? (
              <Chip tone={economicsBasisTone(economics.basis)}>
                {formatMismatchEconomicsBasis(economics.basis)}
              </Chip>
            ) : null}
            {audit ? (
              <Chip tone={audit.enforceReady ? "emerald" : "amber"}>
                risk enforce {audit.enforceReady ? "prêt" : "non prêt"}
              </Chip>
            ) : null}
          </div>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-3 xl:grid-cols-6">
          <AuditInlineMetric label="P fatal 95%" value={formatRiskProbability(pFatalUpper95)} tone={probabilityTone(pFatalUpper95, limit, modelState)} />
          <AuditInlineMetric label="Limite" value={formatRiskProbability(limit)} />
          <AuditInlineMetric label="Taille" value={formatPairSize(economics?.pairSize)} />
          <AuditInlineMetric label="Coût" value={formatV2Usd(economics?.totalCostUsd)} />
          <AuditInlineMetric label="P&L conservateur" value={formatSignedUsd(conservativePnl)} tone={pnlTone(conservativePnl)} />
          <AuditInlineMetric label="P&L fatal" value={formatSignedUsd(fatalPnl)} tone={pnlTone(fatalPnl)} />
        </div>
      </div>
      {audit ? (
        <MismatchAuditReasons audit={audit} compact />
      ) : (
        <div className="border-t border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-5 py-2 text-[10px] text-[var(--wa-dim)]">
          {opportunity
            ? "Audit absent : les champs disponibles ne suffisent pas à reproduire exactement la décision block_only."
            : "Combinaison absente du dernier snapshot : aucun verdict block_only disponible."}
        </div>
      )}
    </div>
  );
}

function MismatchAuditReasons({
  audit,
  compact = false,
}: {
  audit: MismatchRiskAudit;
  compact?: boolean;
}) {
  const rows: Array<{ label: string; values: string[]; tone: V2Tone }> = [];
  if (audit.blockingReasons.length > 0) {
    rows.push({ label: "Blocage", values: audit.blockingReasons, tone: "rose" });
  }
  if (!audit.baseEligible && audit.baseReasons.length > 0) {
    rows.push({ label: "Socle", values: audit.baseReasons, tone: "amber" });
  }
  if (!audit.enforceReady && audit.enforceReasons.length > 0) {
    rows.push({ label: "Risk enforce non prêt", values: audit.enforceReasons, tone: "amber" });
  }
  if (audit.executionUsable === false && audit.executionReason) {
    rows.push({ label: "Exécution", values: [audit.executionReason], tone: "amber" });
  }
  if (rows.length === 0 && audit.diagnosticReasonCodes.length > 0) {
    rows.push({ label: "Diagnostic", values: audit.diagnosticReasonCodes, tone: "mist" });
  }

  return (
    <div className={`border-t border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] ${compact ? "px-5 py-2" : "px-3 py-2"}`}>
      {rows.length === 0 ? (
        <div className="text-[10px] text-[var(--wa-dim)]">Aucune raison de blocage enregistrée.</div>
      ) : (
        rows.map((row) => (
          <div key={row.label} className={`text-[10px] leading-5 ${V2_TONE_TEXT[row.tone]}`}>
            <span className="font-semibold">{row.label} :</span> {row.values.map(formatRiskReason).join(" · ")}
          </div>
        ))
      )}
    </div>
  );
}

function AuditInlineMetric({
  label,
  value,
  tone = "mist",
}: {
  label: string;
  value: string;
  tone?: V2Tone;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[8px] uppercase tracking-[0.14em] text-[var(--wa-dim)]">{label}</div>
      <div className={`mt-1 break-words font-mono text-[11px] ${V2_TONE_TEXT[tone]}`}>{value}</div>
    </div>
  );
}

function RiskPanelHeader({
  title,
  mode,
  modelState,
  executionUsable,
}: {
  title: string;
  mode: MismatchRiskMode;
  modelState: MismatchModelDisplayState;
  executionUsable?: boolean;
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
        {modelState !== "unavailable" ? (
          <Chip tone={executionUsable === false ? "amber" : "emerald"}>
            {executionUsable === false ? "diagnostic" : "exec fresh"}
          </Chip>
        ) : null}
      </div>
    </div>
  );
}

function RiskEstimateFooter({ estimate }: { estimate: MismatchRiskEstimate | null }) {
  const modelState = getMismatchModelDisplayState(estimate);
  const details = estimate
    ? `${estimate.observationCount} obs · Chainlink ${formatRiskAge(estimate.chainlinkAgeMs)} · CF ${formatRiskAge(estimate.cfAgeMs)} · skew ${formatRiskAge(estimate.sourceTimestampSkewMs)}`
    : "Aucune estimation pour le créneau";

  return (
    <div className="border-t border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-5 py-3">
      <div className="flex flex-col gap-1 font-mono text-[9px] text-[var(--wa-dim)] sm:flex-row sm:items-center sm:justify-between">
        <span className="break-all">{estimate?.modelVersion ?? "model --"}</span>
        <span>{details}</span>
      </div>
      {estimate?.reason ? (
        <div className={`mt-2 text-[10px] ${modelState === "calibrated" ? V2_TONE_TEXT.mist : V2_TONE_TEXT.amber}`}>
          {formatRiskReason(estimate.reason)}
        </div>
      ) : null}
      {estimate?.executionUsable === false && estimate.executionReason ? (
        <div className={`mt-2 text-[10px] ${V2_TONE_TEXT.amber}`}>
          Diagnostic disponible, exécution stricte bloquée : {formatRiskReason(estimate.executionReason)}
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

function auditDecisionTone(decision: MismatchRiskCounterfactualDecision): V2Tone {
  if (isMismatchBlockingDecision(decision)) {
    return "rose";
  }
  if (decision === "would_allow") {
    return "emerald";
  }
  if (decision === "would_allow_fail_open" || decision === "reference_allow") {
    return "amber";
  }
  return "mist";
}

function economicsBasisTone(basis: MismatchEconomicsBasis): V2Tone {
  return basis === "executable" ? "emerald" : basis === "reference" ? "amber" : "mist";
}

function settlementTone(classification: MismatchSettlementClassification): V2Tone {
  return classification === "fatal_mismatch"
    ? "rose"
    : classification === "double_payout"
      ? "gold"
      : "emerald";
}

function combinedOutcomeTone(
  decision: MismatchRiskCounterfactualDecision,
  classification: MismatchSettlementClassification,
): V2Tone {
  if (classification === "fatal_mismatch") {
    return "rose";
  }
  if (classification === "double_payout") {
    return "gold";
  }
  return auditDecisionTone(decision);
}

function getAuditModelState(
  audit: MismatchRiskAudit | null,
  fallback: MismatchModelDisplayState,
): MismatchModelDisplayState {
  if (!audit) {
    return fallback;
  }
  if (audit.modelVersion.toLowerCase().includes("uncalibrated")) {
    return "uncalibrated";
  }
  return audit.estimateAvailable ? "calibrated" : "unavailable";
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

function formatPairSize(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function formatAuditSource(source: MismatchRiskAudit["source"]) {
  if (source === "execution") {
    return "audit exact d’exécution";
  }
  if (source === "reconstructed") {
    return "audit historique reconstruit";
  }
  return "audit du snapshot";
}

function formatRiskReason(reason: string) {
  const labels: Record<string, string> = {
    economics_unavailable: "économie mismatch indisponible : prix, taille ou coût non exploitable",
    reference_economics_unavailable: "économie de référence indisponible faute de prix valides sur les deux jambes",
    chainlink_stale: "prix Chainlink trop ancien",
    cf_stale: "prix CF trop ancien",
    oracle_timestamp_skew: "timestamps Chainlink et CF trop éloignés",
    insufficient_history: "historique encore insuffisant",
    insufficient_returns: "variations appariées encore insuffisantes",
    estimate_unavailable: "estimation probabiliste indisponible",
    estimate_invalid: "économie exécutable invalide",
    execution_reference_unusable: "références d’exécution trop anciennes ou désynchronisées",
    model_uncalibrated: "modèle non calibré",
    non_positive_aligned_margin: "marge alignée non positive après frais",
    fatal_probability_above_limit: "probabilité fatale supérieure à la limite économique",
    invalid_capital: "capital global invalide",
    invalid_risk_config: "configuration globale du risque invalide",
    cluster_exposure_unavailable: "exposition du cluster indéterminée",
    cluster_expected_budget_exceeded: "budget de perte fatale probabilisée dépassé",
    cluster_absolute_budget_exceeded: "budget de perte fatale absolue dépassé",
    reference_economics_only: "économie de référence uniquement, aucune taille exécutable",
    historical_execution_quality_unavailable: "qualité d’exécution historique inconnue",
  };
  return labels[reason] ?? reason;
}
