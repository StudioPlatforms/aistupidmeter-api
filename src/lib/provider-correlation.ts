/**
 * PHASE 3: Cross-Model Provider Correlation Analysis
 * 
 * Detects provider-level incidents by correlating drift across models
 * from the same provider. If 50%+ of OpenAI models degrade simultaneously,
 * that's a provider incident — not individual model drift.
 */

import { db } from '../db';
import { models, scores, incidents } from '../db/schema';
import { eq, desc, and, gte, sql } from 'drizzle-orm';
import { computeDriftSignature, DriftSignature } from './drift-detection';

// ============================================================================
// TYPES
// ============================================================================

export interface ProviderCorrelation {
  provider: string;
  totalModels: number;
  alertCount: number;
  warningCount: number;
  stableCount: number;
  degradedCount: number;
  alertRate: number;          // 0.0–1.0
  isProviderIncident: boolean; // True if ≥50% models are WARNING/ALERT
  isPlatformWide: boolean;     // True if affects ≥50% of ALL providers
  affectedModels: Array<{
    modelId: number;
    modelName: string;
    regime: string;
    driftStatus: string;
    currentScore: number;
  }>;
  severity: 'none' | 'minor' | 'major' | 'critical';
  recommendation: string;
}

export interface CorrelationReport {
  timestamp: Date;
  totalModels: number;
  totalProviders: number;
  providerCorrelations: ProviderCorrelation[];
  platformWideIncident: boolean;
  platformAlertRate: number;
  summary: string;
}

// ============================================================================
// MAIN ANALYSIS
// ============================================================================

/**
 * Analyze cross-model correlation to detect provider-level incidents
 * Called after computeAllDriftSignatures() in the hourly scheduler
 */
export async function analyzeProviderCorrelation(): Promise<CorrelationReport> {
  console.log('🔗 [PROVIDER-CORRELATION] Analyzing cross-model drift patterns...');
  
  // Get all active models grouped by provider
  const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
  
  const modelsByProvider = new Map<string, typeof allModels>();
  for (const model of allModels) {
    const provider = model.vendor;
    if (!modelsByProvider.has(provider)) {
      modelsByProvider.set(provider, []);
    }
    modelsByProvider.get(provider)!.push(model);
  }
  
  const providerCorrelations: ProviderCorrelation[] = [];
  let globalAlertCount = 0;
  let globalTotalModels = 0;
  
  // Analyze each provider
  for (const [provider, providerModels] of modelsByProvider.entries()) {
    let alertCount = 0;
    let warningCount = 0;
    let stableCount = 0;
    let degradedCount = 0;
    const affectedModels: ProviderCorrelation['affectedModels'] = [];
    
    for (const model of providerModels) {
      try {
        const signature = await computeDriftSignature(model.id);
        
        if (signature.driftStatus === 'ALERT') alertCount++;
        if (signature.driftStatus === 'WARNING') warningCount++;
        if (signature.driftStatus === 'NORMAL') stableCount++;
        if (signature.regime === 'DEGRADED') degradedCount++;
        
        if (signature.driftStatus !== 'NORMAL') {
          affectedModels.push({
            modelId: model.id,
            modelName: model.name,
            regime: signature.regime,
            driftStatus: signature.driftStatus,
            currentScore: signature.currentScore
          });
        }
      } catch (error) {
        // Skip models that fail drift computation
        console.warn(`⚠️ Provider correlation: Skip ${model.name}: ${String(error).slice(0, 80)}`);
      }
    }
    
    const totalModels = providerModels.length;
    const alertRate = totalModels > 0 ? (alertCount + warningCount) / totalModels : 0;
    const isProviderIncident = alertRate >= 0.5 && totalModels >= 2;
    
    globalAlertCount += alertCount + warningCount;
    globalTotalModels += totalModels;
    
    // Determine severity
    let severity: ProviderCorrelation['severity'] = 'none';
    if (alertRate >= 0.75) severity = 'critical';
    else if (alertRate >= 0.5) severity = 'major';
    else if (alertRate >= 0.25) severity = 'minor';
    
    // Generate recommendation
    let recommendation = '';
    if (isProviderIncident) {
      recommendation = `Provider-level incident: ${alertCount + warningCount}/${totalModels} ${provider} models affected. `;
      if (degradedCount > totalModels / 2) {
        recommendation += 'Consider routing traffic away from this provider.';
      } else {
        recommendation += 'Monitor closely for resolution.';
      }
    }
    
    providerCorrelations.push({
      provider,
      totalModels,
      alertCount,
      warningCount,
      stableCount,
      degradedCount,
      alertRate,
      isProviderIncident,
      isPlatformWide: false, // Set below
      affectedModels,
      severity,
      recommendation
    });
    
    if (isProviderIncident) {
      console.log(`🚨 [PROVIDER-CORRELATION] ${provider}: ${Math.round(alertRate * 100)}% models affected (${alertCount} ALERT, ${warningCount} WARNING out of ${totalModels})`);
    }
  }
  
  // Check for platform-wide incident
  const platformAlertRate = globalTotalModels > 0 ? globalAlertCount / globalTotalModels : 0;
  const platformWideIncident = platformAlertRate >= 0.5;
  
  if (platformWideIncident) {
    console.log(`🚨🚨 [PROVIDER-CORRELATION] PLATFORM-WIDE INCIDENT: ${Math.round(platformAlertRate * 100)}% of ALL models affected!`);
    console.log(`🚨🚨 This may indicate an infrastructure issue rather than model drift.`);
    
    // Mark all provider correlations as platform-wide
    for (const pc of providerCorrelations) {
      pc.isPlatformWide = true;
    }
  }
  
  // Generate summary
  const incidentProviders = providerCorrelations.filter(p => p.isProviderIncident);
  let summary: string;
  if (platformWideIncident) {
    summary = `PLATFORM-WIDE INCIDENT: ${Math.round(platformAlertRate * 100)}% of models affected across all providers. Likely infrastructure issue.`;
  } else if (incidentProviders.length > 0) {
    summary = `Provider incidents detected: ${incidentProviders.map(p => `${p.provider} (${Math.round(p.alertRate * 100)}%)`).join(', ')}`;
  } else {
    summary = `All providers operating normally. ${globalAlertCount} individual model alerts across ${modelsByProvider.size} providers.`;
  }
  
  console.log(`✅ [PROVIDER-CORRELATION] ${summary}`);
  
  return {
    timestamp: new Date(),
    totalModels: globalTotalModels,
    totalProviders: modelsByProvider.size,
    providerCorrelations,
    platformWideIncident,
    platformAlertRate,
    summary
  };
}

/**
 * Save provider incident to database if detected
 */
export async function saveProviderIncident(correlation: ProviderCorrelation): Promise<void> {
  if (!correlation.isProviderIncident || correlation.affectedModels.length === 0) return;
  
  const firstAffected = correlation.affectedModels[0];
  
  try {
    // Check for existing recent incident
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const existing = await db.select()
      .from(incidents)
      .where(and(
        eq(incidents.provider, correlation.provider),
        eq(incidents.incidentType, 'provider_wide_degradation'),
        gte(incidents.detectedAt, twentyFourHoursAgo)
      ))
      .limit(1);
    
    if (existing.length > 0) {
      console.log(`⏭️ Provider incident for ${correlation.provider} already recorded`);
      return;
    }
    
    await db.insert(incidents).values({
      modelId: firstAffected.modelId,
      provider: correlation.provider,
      incidentType: 'provider_wide_degradation',
      severity: correlation.severity === 'critical' ? 'critical' : 'major',
      title: `PROVIDER INCIDENT: ${correlation.provider.toUpperCase()} — ${correlation.affectedModels.length}/${correlation.totalModels} models affected`,
      description: correlation.recommendation,
      detectedAt: new Date().toISOString(),
      affectedRequests: 0,
      metadata: JSON.stringify({
        alertRate: correlation.alertRate,
        affectedModels: correlation.affectedModels.map(m => m.modelName),
        severity: correlation.severity
      })
    });
    
    console.log(`💾 Provider incident saved: ${correlation.provider}`);
  } catch (error) {
    console.error(`Failed to save provider incident:`, error);
  }
}
