import { useId } from 'react';

import type { CompanionGaze } from '../../../../shared/desktopCompanion/constants';
import { CompanionMood } from './companionMood';

interface LobsterHoodProps {
  mood: CompanionMood;
  gaze?: CompanionGaze;
  blink?: boolean;
  size: number;
  className?: string;
}

const INK = '#22140F';
const SHELL_LINE = '#E9472A';
const MOUTH = '#B5432C';
const MOUTH_DARK = '#7A1E10';
const EYES = { left: 48, right: 72, y: 76 };

/** A mitten-shaped claw pointing up, its base near the origin. */
const CLAW_PATH = 'M-10 8 C-17 2 -17 -11 -10 -17 C-6 -21 0 -22 4 -19 C6.5 -16 6 -11 2 -7 C7 -11 13 -13.5 15 -8.5 C17.5 -3 14 3 9 6 C4 10 -4 10 -10 8 Z';

interface ClawPose { rotate: number; dx: number; dy: number }
const CLAW = {
  rest: { rotate: -26, dx: 0, dy: 0 },
  /** Alert: straight up. */
  perk: { rotate: -14, dx: 0, dy: -2 },
  /** Celebrating: thrown up and out. */
  hooray: { rotate: -36, dx: 1, dy: -6 },
  droop: { rotate: -62, dx: -2, dy: 4 },
} satisfies Record<string, ClawPose>;

function clawPoses(mood: CompanionMood): [ClawPose, ClawPose] {
  switch (mood) {
    case CompanionMood.Curious:
    case CompanionMood.Attention:
    case CompanionMood.Catch:
      return [CLAW.perk, CLAW.perk];
    case CompanionMood.Happy:
    case CompanionMood.Done:
      return [CLAW.hooray, CLAW.hooray];
    case CompanionMood.Idea:
      // Raising a hand.
      return [CLAW.rest, CLAW.hooray];
    case CompanionMood.Error:
    case CompanionMood.Snooze:
      return [CLAW.droop, CLAW.droop];
    default:
      return [CLAW.rest, CLAW.rest];
  }
}

const ANTENNAE = {
  rest: { left: 'M52 33 C50 27 46 22 44 16', right: 'M68 33 C70 27 74 22 76 16', tips: [[43.5, 14.5], [76.5, 14.5]] },
  perk: { left: 'M52 33 C51 26 49 20 48 13', right: 'M68 33 C69 26 71 20 72 13', tips: [[47.5, 11.5], [72.5, 11.5]] },
  droop: { left: 'M52 33 C48 29 40 27 30 30', right: 'M68 33 C72 29 80 27 90 30', tips: [[28.6, 30.4], [91.4, 30.4]] },
} as const;

function antennaePose(mood: CompanionMood): keyof typeof ANTENNAE {
  if (mood === CompanionMood.Error || mood === CompanionMood.Snooze) return 'droop';
  if (mood === CompanionMood.Idle || mood === CompanionMood.Working) return 'rest';
  return 'perk';
}

function Claw({ pose, side }: { pose: ClawPose; side: 'left' | 'right' }) {
  const id = useId().replace(/:/g, '');
  const placement = side === 'left' ? 'translate(30 40)' : 'translate(90 40) scale(-1 1)';
  return (
    <g transform={placement}>
      <g className="hood-claw-pose" style={{ transform: `rotate(${pose.rotate}deg) translate(${pose.dx}px, ${pose.dy}px)` }}>
        <g className={`hood-claw hood-claw-${side}`}>
          <defs>
            <radialGradient id={`${id}-claw`} cx="40%" cy="30%" r="75%">
              <stop offset="0" stopColor="#FF8E6A" />
              <stop offset=".6" stopColor="#F0472A" />
              <stop offset="1" stopColor="#C9290F" />
            </radialGradient>
          </defs>
          <path d={CLAW_PATH} fill={`url(#${id}-claw)`} />
          <ellipse cx="-6" cy="-10" rx="4" ry="2.4" fill="#fff" opacity=".35" transform="rotate(-30 -6 -10)" />
        </g>
      </g>
    </g>
  );
}

function Antennae({ mood }: { mood: CompanionMood }) {
  const pose = ANTENNAE[antennaePose(mood)];
  return (
    <g className="hood-antennae">
      {(['left', 'right'] as const).map((side, index) => (
        <g key={side} className={`hood-antenna hood-antenna-${side}`}>
          <path d={pose[side]} fill="none" stroke={SHELL_LINE} strokeWidth="3" strokeLinecap="round" />
          <circle cx={pose.tips[index][0]} cy={pose.tips[index][1]} r="3.2" fill="#FFD2B3" stroke={SHELL_LINE} strokeWidth="1.4" />
        </g>
      ))}
    </g>
  );
}

function Eyes({ mood, gaze, blink }: { mood: CompanionMood; gaze: CompanionGaze; blink: boolean }) {
  if (mood === CompanionMood.Done || mood === CompanionMood.Happy) {
    return (
      <g className="hood-eyes" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round">
        <path d={`M${EYES.left - 6.5} ${EYES.y + 2} Q${EYES.left} ${EYES.y - 6.5} ${EYES.left + 6.5} ${EYES.y + 2}`} />
        <path d={`M${EYES.right - 6.5} ${EYES.y + 2} Q${EYES.right} ${EYES.y - 6.5} ${EYES.right + 6.5} ${EYES.y + 2}`} />
      </g>
    );
  }
  if (mood === CompanionMood.Snooze) {
    return (
      <g className="hood-eyes" stroke={INK} strokeWidth="2.6" fill="none" strokeLinecap="round">
        <path d={`M${EYES.left - 6} ${EYES.y} Q${EYES.left} ${EYES.y + 4.5} ${EYES.left + 6} ${EYES.y}`} />
        <path d={`M${EYES.right - 6} ${EYES.y} Q${EYES.right} ${EYES.y + 4.5} ${EYES.right + 6} ${EYES.y}`} />
      </g>
    );
  }
  const scale = mood === CompanionMood.Attention || mood === CompanionMood.Catch ? 1.12 : 1;
  const dx = gaze.x * 3.2 + (mood === CompanionMood.Working ? 2 : 0);
  const dy = gaze.y * 2.6 + (mood === CompanionMood.Working ? -3 : 0);
  return (
    <g className="hood-eyes" transform={`translate(${dx} ${dy})`}>
      <g className={blink ? 'hood-eyes-lid is-blinking' : 'hood-eyes-lid'}>
        {[EYES.left, EYES.right].map(x => (
          <g key={x} transform={`translate(${x} ${EYES.y}) scale(${scale}) translate(${-x} ${-EYES.y})`}>
            <ellipse cx={x} cy={EYES.y} rx="6.4" ry="9.4" fill={INK} />
            <circle cx={x + 2.4} cy={EYES.y - 4.4} r="2.4" fill="#fff" />
            <circle cx={x - 1.4} cy={EYES.y + 3.5} r="1" fill="#fff" opacity=".7" />
          </g>
        ))}
      </g>
    </g>
  );
}

function Mouth({ mood }: { mood: CompanionMood }) {
  switch (mood) {
    case CompanionMood.Done:
    case CompanionMood.Happy:
      return <path className="hood-mouth" d="M53.5 88.5 C55 95.5 65 95.5 66.5 88.5 Z" fill={MOUTH_DARK} />;
    case CompanionMood.Catch:
      return (
        <g className="hood-mouth">
          <ellipse cx="60" cy="91.5" rx="4.6" ry="5" fill={MOUTH_DARK} />
          <ellipse cx="60" cy="93.6" rx="2.6" ry="1.9" fill="#FF8C7A" />
        </g>
      );
    case CompanionMood.Curious:
    case CompanionMood.Attention:
      return <circle className="hood-mouth" cx="60" cy="91" r="2.8" fill={MOUTH_DARK} />;
    case CompanionMood.Error:
      return <path className="hood-mouth" d="M54 92 Q57 89.5 60 92 Q63 94.5 66 92" stroke={MOUTH} strokeWidth="2.2" fill="none" strokeLinecap="round" />;
    case CompanionMood.Working:
    case CompanionMood.Snooze:
      return <path className="hood-mouth" d="M56.5 91.5 Q60 93.5 63.5 91.5" stroke={MOUTH} strokeWidth="2.2" fill="none" strokeLinecap="round" />;
    default:
      return <path className="hood-mouth" d="M55 90.5 Q60 94.5 65 90.5" stroke={MOUTH} strokeWidth="2.2" fill="none" strokeLinecap="round" />;
  }
}

function Extras({ mood }: { mood: CompanionMood }) {
  switch (mood) {
    case CompanionMood.Working:
      return (
        <g className="hood-thought" fill="#fff" stroke={SHELL_LINE} strokeWidth="1.5">
          <circle cx="104" cy="49" r="2.6" />
          <circle cx="111" cy="39.5" r="3.4" />
          <circle cx="119.5" cy="27.5" r="4.3" />
        </g>
      );
    case CompanionMood.Idea:
      return (
        <g className="hood-sparkle" fill="#FFB21E" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round">
          <path d="M109 14 l4 9.5 9.5 4 -9.5 4 -4 9.5 -4 -9.5 -9.5 -4 9.5 -4z" />
          <circle cx="119" cy="46" r="3.4" />
        </g>
      );
    case CompanionMood.Snooze:
      return (
        <g className="hood-z" fill="#8A847D" stroke="#fff" strokeWidth="2" paintOrder="stroke" fontFamily="-apple-system, sans-serif" fontWeight="700">
          <text x="97" y="36" fontSize="15">z</text>
          <text x="108" y="23" fontSize="10">z</text>
        </g>
      );
    case CompanionMood.Error:
      return <path className="hood-sweat" d="M99 44 C95 50 95 54 99 55 C103 54 103 50 99 44 Z" fill="#7CC4FF" />;
    default:
      return null;
  }
}

/** The default companion: a small lobster in a hood, whose claws and whiskers show its mood. */
export default function LobsterHood({ mood, gaze = { x: 0, y: 0 }, blink = false, size, className }: LobsterHoodProps) {
  const id = useId().replace(/:/g, '');
  const [left, right] = clawPoses(mood);
  const blush = mood === CompanionMood.Done || mood === CompanionMood.Happy ? { rx: 6, ry: 3.4, opacity: 0.9 } : { rx: 5, ry: 3, opacity: 0.75 };
  return (
    <svg className={`lobster-hood ${className ?? ''}`} data-mood={mood} viewBox="0 0 120 120" width={size} height={size} aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-shell`} cx="38%" cy="28%" r="80%">
          <stop offset="0" stopColor="#FF9F7E" />
          <stop offset=".45" stopColor="#FF5B3B" />
          <stop offset="1" stopColor="#D9301A" />
        </radialGradient>
        <linearGradient id={`${id}-face`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE9D8" />
          <stop offset="1" stopColor="#FFCDAE" />
        </linearGradient>
        <filter id={`${id}-soft`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6" /></filter>
      </defs>
      <Claw pose={left} side="left" />
      <Claw pose={right} side="right" />
      <Antennae mood={mood} />
      <g className="hood-body">
        <path d="M60 30 C89 30 105 48 105 72 C105 97 86 111 60 111 C34 111 15 97 15 72 C15 48 31 30 60 30 Z" fill={`url(#${id}-shell)`} />
        <ellipse cx="42" cy="44" rx="14" ry="7" fill="#fff" opacity=".45" transform="rotate(-24 42 44)" filter={`url(#${id}-soft)`} />
        <rect x="30" y="54.5" width="60" height="46" rx="21" fill="#C83418" opacity=".35" />
        <rect x="30" y="53" width="60" height="46" rx="21" fill={`url(#${id}-face)`} />
        <ellipse cx="38.5" cy="86" fill="#FFA39A" {...blush} />
        <ellipse cx="81.5" cy="86" fill="#FFA39A" {...blush} />
        <Eyes mood={mood} gaze={gaze} blink={blink} />
        <Mouth mood={mood} />
      </g>
      <Extras mood={mood} />
    </svg>
  );
}
