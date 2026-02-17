/**
 * PHASE 3: Drift Alert Notification System
 * 
 * Sends webhook notifications when drift events are detected.
 * Supports multiple webhook targets via DRIFT_WEBHOOK_URLS env var.
 */

import { ChangePoint } from './drift-detection';

// ============================================================================
// TYPES
// ============================================================================

export interface DriftAlert {
  type: 'change_point' | 'regime_change' | 'provider_incident' | 'behavioral_drift';
  severity: 'info' | 'warning' | 'critical';
  modelId?: number;
  modelName?: string;
  provider?: string;
  title: string;
  description: string;
  data: Record<string, any>;
  timestamp: string;
}

// ============================================================================
// WEBHOOK DELIVERY
// ============================================================================

/**
 * Get configured webhook URLs from environment
 */
function getWebhookUrls(): string[] {
  const raw = process.env.DRIFT_WEBHOOK_URLS || '';
  return raw.split(',').map(u => u.trim()).filter(u => u.length > 0);
}

/**
 * Send a drift alert to all configured webhooks
 */
export async function sendDriftAlert(alert: DriftAlert): Promise<void> {
  const webhookUrls = getWebhookUrls();
  
  if (webhookUrls.length === 0) {
    // No webhooks configured — just log
    if (alert.severity === 'critical') {
      console.log(`🚨 [DRIFT-ALERT] ${alert.title}: ${alert.description}`);
    } else if (alert.severity === 'warning') {
      console.log(`⚠️ [DRIFT-ALERT] ${alert.title}: ${alert.description}`);
    }
    return;
  }
  
  const payload = {
    source: 'ai-stupid-level',
    version: '1.0',
    ...alert
  };
  
  // Send to all webhooks in parallel (fire-and-forget with logging)
  const results = await Promise.allSettled(
    webhookUrls.map(async (url) => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'AIStupidLevel-DriftAlert/1.0',
            'X-Alert-Type': alert.type,
            'X-Alert-Severity': alert.severity
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000) // 5s timeout
        });
        
        if (!response.ok) {
          console.warn(`⚠️ Webhook ${url} returned ${response.status}`);
        }
      } catch (error) {
        console.warn(`⚠️ Webhook delivery failed for ${url}: ${String(error).slice(0, 100)}`);
      }
    })
  );
  
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  if (succeeded < webhookUrls.length) {
    console.warn(`⚠️ [DRIFT-ALERT] ${succeeded}/${webhookUrls.length} webhooks delivered`);
  }
}

// ============================================================================
// ALERT BUILDERS
// ============================================================================

/**
 * Send alert for a detected change-point
 */
export async function alertChangePoint(
  changePoint: ChangePoint,
  modelName: string,
  provider: string
): Promise<void> {
  const severity = changePoint.changeType === 'degradation' 
    ? (Math.abs(changePoint.delta) > 15 ? 'critical' : 'warning')
    : 'info';
  
  await sendDriftAlert({
    type: 'change_point',
    severity,
    modelId: changePoint.modelId,
    modelName,
    provider,
    title: `${changePoint.changeType.toUpperCase()}: ${modelName}`,
    description: `Score changed ${changePoint.fromScore} → ${changePoint.toScore} (${changePoint.delta > 0 ? '+' : ''}${changePoint.delta} pts, ${changePoint.significance}σ)`,
    data: {
      fromScore: changePoint.fromScore,
      toScore: changePoint.toScore,
      delta: changePoint.delta,
      significance: changePoint.significance,
      changeType: changePoint.changeType,
      affectedAxes: changePoint.affectedAxes,
      suspectedCause: changePoint.suspectedCause
    },
    timestamp: new Date().toISOString()
  });
}

/**
 * Send alert for regime transition (e.g., STABLE → DEGRADED)
 */
export async function alertRegimeChange(
  modelId: number,
  modelName: string,
  provider: string,
  oldRegime: string,
  newRegime: string,
  currentScore: number,
  primaryIssue?: string
): Promise<void> {
  // Only alert on transitions to worse states
  const regimeOrder = { 'STABLE': 0, 'RECOVERING': 1, 'VOLATILE': 2, 'DEGRADED': 3 };
  const oldOrder = regimeOrder[oldRegime as keyof typeof regimeOrder] ?? 0;
  const newOrder = regimeOrder[newRegime as keyof typeof regimeOrder] ?? 0;
  
  if (newOrder <= oldOrder) return; // Not degrading, skip
  
  const severity = newRegime === 'DEGRADED' ? 'critical' : 'warning';
  
  await sendDriftAlert({
    type: 'regime_change',
    severity,
    modelId,
    modelName,
    provider,
    title: `REGIME: ${modelName} ${oldRegime} → ${newRegime}`,
    description: primaryIssue || `${modelName} transitioned from ${oldRegime} to ${newRegime}. Current score: ${currentScore}.`,
    data: {
      oldRegime,
      newRegime,
      currentScore,
      primaryIssue
    },
    timestamp: new Date().toISOString()
  });
}

/**
 * Send alert for provider-level incident
 */
export async function alertProviderIncident(
  provider: string,
  alertRate: number,
  affectedModels: string[],
  severity: 'warning' | 'critical',
  recommendation: string
): Promise<void> {
  await sendDriftAlert({
    type: 'provider_incident',
    severity,
    provider,
    title: `PROVIDER INCIDENT: ${provider.toUpperCase()} — ${Math.round(alertRate * 100)}% models affected`,
    description: `${affectedModels.length} models showing drift: ${affectedModels.slice(0, 5).join(', ')}${affectedModels.length > 5 ? ` (+${affectedModels.length - 5} more)` : ''}`,
    data: {
      alertRate,
      affectedModels,
      recommendation
    },
    timestamp: new Date().toISOString()
  });
}

/**
 * Send alert for behavioral drift (leading indicator)
 */
export async function alertBehavioralDrift(
  modelId: number,
  modelName: string,
  provider: string,
  driftingMetrics: string[],
  severity: 'warning' | 'critical',
  details: string
): Promise<void> {
  await sendDriftAlert({
    type: 'behavioral_drift',
    severity,
    modelId,
    modelName,
    provider,
    title: `BEHAVIORAL DRIFT: ${modelName} — ${driftingMetrics.join(', ')}`,
    description: details,
    data: {
      driftingMetrics,
      note: 'This is a LEADING INDICATOR — score degradation may follow within 1-3 benchmark cycles'
    },
    timestamp: new Date().toISOString()
  });
}
