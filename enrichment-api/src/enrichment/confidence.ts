import { CONFIDENCE_LEVELS, type Confidence } from './enrichment.types.js';

export function maxConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_LEVELS.indexOf(b) > CONFIDENCE_LEVELS.indexOf(a) ? b : a;
}

export function raiseConfidence(confidence: Confidence): Confidence {
  const next = Math.min(CONFIDENCE_LEVELS.indexOf(confidence) + 1, CONFIDENCE_LEVELS.length - 1);
  return CONFIDENCE_LEVELS[next];
}
