import React from 'react';

import { SkinParticleDensity } from '../../../shared/skin/constants';
import { useSkin } from '../../providers/SkinProvider';

interface SkinAmbientEffectsProps {
  visible: boolean;
}

const PARTICLE_COUNT = 8;

const SkinAmbientEffects: React.FC<SkinAmbientEffectsProps> = ({ visible }) => {
  const { activeSkin } = useSkin();
  const shouldRender = visible
    && activeSkin?.presentation?.effects?.particleDensity === SkinParticleDensity.Sparse;
  if (!shouldRender) return null;

  return (
    <div
      aria-hidden="true"
      className="skin-ambient-effects pointer-events-none absolute inset-0 z-[1] overflow-hidden"
    >
      {Array.from({ length: PARTICLE_COUNT }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
};

export default SkinAmbientEffects;
