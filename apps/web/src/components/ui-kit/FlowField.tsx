/**
 * The entry background: strands of violet light drifting on a slow current. The pointer stirs them
 * and carries a soft spotlight. Plain canvas, no dependency. With reduced motion it draws one still
 * frame; it pauses in hidden tabs and does nothing where canvas is unavailable.
 */
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

const COLORS = ['rgba(183,148,255,0.5)', 'rgba(124,58,237,0.6)', 'rgba(233,168,255,0.36)'];
const REACH = 240;

interface Strand {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  band: number;
}

/** The slow current: a cheap sum of sines, smooth enough to read as flowing silk. */
function current(x: number, y: number, t: number): number {
  return (
    Math.sin(x * 0.0017 + t) * 1.3 +
    Math.cos(y * 0.0023 - t * 0.8) * 1.3 +
    Math.sin((x + y) * 0.0011 + t * 0.6)
  );
}

export function FlowField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const scale = Math.min(window.devicePixelRatio || 1, 1.5);

    let width = 0;
    let height = 0;
    let strands: Strand[] = [];
    let time = Math.random() * 100;
    let frame = 0;

    const pointer = { x: -9999, y: -9999, sx: -9999, sy: -9999, active: false };

    const spawn = (s: Strand) => {
      s.x = Math.random() * width;
      s.y = Math.random() * height;
      s.vx = 0;
      s.vy = 0;
      s.life = 80 + Math.random() * 220;
      s.band = Math.floor(Math.random() * COLORS.length);
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      const count = Math.min(1100, Math.round((width * height) / 1300));
      strands = Array.from({ length: count }, () => {
        const s: Strand = { x: 0, y: 0, vx: 0, vy: 0, life: 0, band: 0 };
        spawn(s);
        return s;
      });
    };

    const step = () => {
      time += 0.0035;
      // Older light fades instead of clearing, which is what draws the silk.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,0.055)';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 1;

      pointer.sx += (pointer.x - pointer.sx) * 0.12;
      pointer.sy += (pointer.y - pointer.sy) * 0.12;

      for (let band = 0; band < COLORS.length; band += 1) {
        ctx.strokeStyle = COLORS[band]!;
        ctx.beginPath();
        for (const s of strands) {
          if (s.band !== band) continue;
          const angle = current(s.x, s.y, time);
          s.vx += Math.cos(angle) * 0.09;
          s.vy += Math.sin(angle) * 0.09;
          if (pointer.active) {
            const dx = s.x - pointer.sx;
            const dy = s.y - pointer.sy;
            const dist = Math.hypot(dx, dy);
            if (dist < REACH && dist > 1) {
              const pull = (1 - dist / REACH) ** 2;
              // A swirl around the cursor, with a slight push so strands part around it.
              s.vx += ((-dy / dist) * 1.5 + (dx / dist) * 0.7) * pull;
              s.vy += ((dx / dist) * 1.5 + (dy / dist) * 0.7) * pull;
            }
          }
          s.vx *= 0.93;
          s.vy *= 0.93;
          ctx.moveTo(s.x, s.y);
          s.x += s.vx;
          s.y += s.vy;
          ctx.lineTo(s.x, s.y);
          s.life -= 1;
          if (s.life <= 0 || s.x < -20 || s.y < -20 || s.x > width + 20 || s.y > height + 20)
            spawn(s);
        }
        ctx.stroke();
      }

      const glow = glowRef.current;
      if (glow && pointer.active)
        glow.style.transform = `translate3d(${pointer.sx - 320}px, ${pointer.sy - 320}px, 0)`;
    };

    const loop = () => {
      step();
      frame = requestAnimationFrame(loop);
    };

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      if (!pointer.active) {
        pointer.active = true;
        pointer.sx = pointer.x;
        pointer.sy = pointer.y;
        if (glowRef.current) glowRef.current.style.opacity = '1';
      }
    };

    const onVisibility = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden) frame = requestAnimationFrame(loop);
    };

    resize();
    if (reduced) {
      for (let i = 0; i < 160; i += 1) step();
      return;
    }
    frame = requestAnimationFrame(loop);
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <div aria-hidden className={cn('pointer-events-none overflow-hidden', className)}>
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      <div
        ref={glowRef}
        className="absolute top-0 left-0 size-[640px] rounded-full opacity-0 transition-opacity duration-500"
        style={{
          background: 'radial-gradient(closest-side, rgba(124,58,237,0.28), transparent 72%)',
        }}
      />
    </div>
  );
}
