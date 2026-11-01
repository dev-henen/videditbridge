//! Atmosphere and light (section 6 of docs/design/cinematic-grade-and-vfx.md): a seeded particle
//! simulation (emitters, gravity, wind, drag, curl-noise turbulence, depth, ground splashes), drifting
//! fractal-noise layers for smoke and fog, and lens flares, drawn into RGBA frames for a layer placed
//! over the picture with a blend mode. The simulation is sequential and seeded, and drawing splits the
//! frame into row bands that each paint every sprite in the same order, so the same spec always gives
//! the same frames, however many threads draw them and however the frames are requested.

use rayon::prelude::*;

/// What a particle looks like.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Shape {
    /// A soft round dot (snow, dust, embers).
    Disc,
    /// A dot smeared along its motion over the shutter (rain, sparks).
    Streak,
    /// A rectangle that spins and tumbles (confetti).
    Rect,
    /// An out-of-focus light: a disc with a brighter rim.
    Bokeh,
}

impl Shape {
    pub fn parse(s: &str) -> Option<Shape> {
        match s {
            "disc" => Some(Shape::Disc),
            "streak" => Some(Shape::Streak),
            "rect" => Some(Shape::Rect),
            "bokeh" => Some(Shape::Bokeh),
            _ => None,
        }
    }
}

/// A line particles hit and splash on (rain on a street). Frame fractions.
#[derive(Clone, Debug)]
pub struct Ground {
    /// Where far particles land; near ones land lower, by `spread` at the nearest.
    pub y: f32,
    pub spread: f32,
    /// Droplets thrown up per hit.
    pub splash: u32,
    /// Droplet radius, frame heights.
    pub splash_size: f32,
}

/// A particle system. Lengths are frame heights, times seconds, angles degrees.
#[derive(Clone, Debug)]
pub struct Emitter {
    /// Where particles are born: x0, y0, x1, y1 as frame fractions (may reach outside the frame).
    pub area: [f32; 4],
    /// Births per second, and at the first moment.
    pub rate: f32,
    pub burst: u32,
    /// Most particles alive at once.
    pub max: u32,
    pub life: [f32; 2],
    pub speed: [f32; 2],
    /// Direction of the starting velocity (0 = right, 90 = down) and the random spread around it.
    pub direction: f32,
    pub spread: f32,
    /// Downward acceleration.
    pub gravity: f32,
    /// Air velocity that drag pulls particles toward (with gravity, it sets how fast they fall).
    pub wind: [f32; 2],
    /// Per second.
    pub drag: f32,
    /// Curl-noise sway: speed, size of the swirls and how fast they change.
    pub turbulence: f32,
    pub turbulence_scale: f32,
    pub turbulence_speed: f32,
    /// Radius.
    pub size: [f32; 2],
    /// (age 0..1, multiplier) stops; empty = 1.
    pub size_over_life: Vec<[f32; 2]>,
    pub opacity: [f32; 2],
    pub opacity_over_life: Vec<[f32; 2]>,
    /// Colors (sRGB 0..1) each particle picks from.
    pub colors: Vec<[f32; 3]>,
    /// (age 0..1, r, g, b) stops that replace the picked color; empty = keep it.
    pub color_over_life: Vec<[f32; 4]>,
    pub shape: Shape,
    /// Edge softness, a fraction of the radius.
    pub softness: f32,
    /// Streak length as a fraction of a frame's motion (1 = a 360 degree shutter).
    pub streak: f32,
    /// Rect width over height.
    pub aspect: f32,
    /// Turn speed range, degrees per second (each particle turns either way).
    pub spin: [f32; 2],
    /// Tumbles per second (rects narrow and darken as they turn edge-on).
    pub flip: f32,
    /// Brightness wobble 0..1, and how fast.
    pub flicker: f32,
    pub flicker_rate: f32,
    /// A soft halo around each particle, 0..1.
    pub glow: f32,
    /// Size and speed multiplier for the farthest and nearest particles (depth is random per particle).
    pub depth: [f32; 2],
    /// Extra blur of the nearest particles, frame heights (grows with the square of nearness).
    pub depth_blur: f32,
    /// Particles add light (embers, sparks, bokeh) instead of covering what is under them (snow).
    pub additive: bool,
    pub ground: Option<Ground>,
}

/// Drifting fractal noise (smoke, fog, mist).
#[derive(Clone, Debug)]
pub struct Noise {
    pub color: [f32; 3],
    pub opacity: f32,
    /// Size of the billows, frame heights.
    pub scale: f32,
    pub octaves: u32,
    /// Frame heights per second.
    pub drift: [f32; 2],
    /// How fast the shapes change, per second.
    pub evolve: f32,
    /// Noise values mapped to no density and to full density (smoothstep).
    pub density: [f32; 2],
    /// Density multiplier at the top and at the bottom of the frame.
    pub falloff: [f32; 2],
    /// Layers at different sizes and speeds (parallax).
    pub layers: u32,
    /// Computed at 1/downscale size and smoothly enlarged.
    pub downscale: u32,
}

#[derive(Clone, Debug)]
pub struct Ghost {
    /// Place on the line from the light (0) through the frame center (1) and beyond.
    pub at: f32,
    /// Radius, frame heights at full brightness.
    pub size: f32,
    pub color: [f32; 3],
    pub opacity: f32,
    pub ring: bool,
}

/// A lens flare from a light source that may move and change brightness.
#[derive(Clone, Debug)]
pub struct Flare {
    /// Source per output frame, frame fractions (the last one holds after the list ends).
    pub positions: Vec<[f32; 2]>,
    /// Brightness per output frame, 0..2; sizes grow with its square root.
    pub intensity: Vec<f32>,
    pub color: [f32; 3],
    /// Glow radius, frame heights.
    pub size: f32,
    /// Horizontal streak half-length, frame widths (0 = none).
    pub streak: f32,
    pub streak_color: [f32; 3],
    pub ghosts: Vec<Ghost>,
}

#[derive(Clone, Debug)]
pub enum System {
    Particles(Emitter),
    Noise(Noise),
    Flare(Flare),
}

#[derive(Clone, Debug)]
pub struct Spec {
    pub width: usize,
    pub height: usize,
    pub fps: f32,
    pub seed: u64,
    /// Seconds simulated before the first frame, so rain or snow already fills it.
    pub preroll: f32,
    /// Simulated time per output frame, in frames (the speed of the footage under it); missing = 1.
    pub time_scale: Vec<f32>,
    pub systems: Vec<System>,
}

// ---------------------------------------------------------------------------------------------
// Randomness and noise
// ---------------------------------------------------------------------------------------------

/// SplitMix64: small, fast and the same everywhere.
#[derive(Clone)]
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, 1).
    fn f(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
    fn range(&mut self, r: [f32; 2]) -> f32 {
        r[0] + (r[1] - r[0]) * self.f()
    }
}

fn hash3(x: i32, y: i32, z: i32, seed: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x8DA6_B343) ^ (y as u32).wrapping_mul(0xD816_3841) ^ (z as u32).wrapping_mul(0xCB1A_B31F) ^ seed.wrapping_mul(0x1656_67B1);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5BD1_E995);
    h ^= h >> 15;
    (h & 0xFF_FFFF) as f32 / 16_777_215.0
}

fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// Value noise in 0..1, smooth in x, y and z.
pub fn noise3(x: f32, y: f32, z: f32, seed: u32) -> f32 {
    let (xf, yf, zf) = (x.floor(), y.floor(), z.floor());
    let (xi, yi, zi) = (xf as i32, yf as i32, zf as i32);
    let (u, v, w) = (fade(x - xf), fade(y - yf), fade(z - zf));
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let c = |dx: i32, dy: i32, dz: i32| hash3(xi + dx, yi + dy, zi + dz, seed);
    let x00 = lerp(c(0, 0, 0), c(1, 0, 0), u);
    let x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
    let x01 = lerp(c(0, 0, 1), c(1, 0, 1), u);
    let x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
    lerp(lerp(x00, x10, v), lerp(x01, x11, v), w)
}

/// Fractal sum of `octaves` noise layers, normalized to 0..1.
pub fn fbm(x: f32, y: f32, z: f32, octaves: u32, seed: u32) -> f32 {
    let (mut sum, mut amp, mut norm, mut f) = (0.0, 1.0, 0.0, 1.0);
    for o in 0..octaves.max(1) {
        sum += amp * noise3(x * f, y * f, z * f, seed.wrapping_add(o * 7919));
        norm += amp;
        amp *= 0.5;
        f *= 2.03;
    }
    sum / norm
}

/// Divergence-free swirl: the curl of a noise potential, roughly -1..1 per axis.
fn curl(x: f32, y: f32, t: f32, seed: u32) -> (f32, f32) {
    let e = 0.05;
    let p = |x: f32, y: f32| noise3(x, y, t, seed);
    let dy = (p(x, y + e) - p(x, y - e)) / (2.0 * e);
    let dx = (p(x + e, y) - p(x - e, y)) / (2.0 * e);
    (0.5 * dy, -0.5 * dx)
}

/// Piecewise-linear lookup in (t, value) stops; empty = 1.
fn stops(list: &[[f32; 2]], t: f32) -> f32 {
    match list.len() {
        0 => 1.0,
        _ if t <= list[0][0] => list[0][1],
        _ => {
            for w in list.windows(2) {
                if t <= w[1][0] {
                    let u = (t - w[0][0]) / (w[1][0] - w[0][0]).max(1e-6);
                    return w[0][1] + (w[1][1] - w[0][1]) * u;
                }
            }
            list[list.len() - 1][1]
        }
    }
}

fn color_stops(list: &[[f32; 4]], t: f32) -> [f32; 3] {
    let ch = |c: usize| stops(&list.iter().map(|s| [s[0], s[c]]).collect::<Vec<_>>(), t);
    [ch(1), ch(2), ch(3)]
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Particle {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    /// Last step's motion, pixels per second (for streaks).
    mx: f32,
    my: f32,
    age: f32,
    life: f32,
    r: f32,
    opacity: f32,
    color: [f32; 3],
    /// Depth 0 (far) .. 1 (near).
    z: f32,
    rot: f32,
    spin: f32,
    flip: f32,
    phase: f32,
    splash: bool,
}

struct Sim {
    alive: Vec<Particle>,
    rng: Rng,
    carry: f32,
}

/// Step one particle system by `dt` seconds of footage time, at sim time `t`.
fn step(e: &Emitter, sim: &mut Sim, w: f32, h: f32, t: f32, dt: f32, seed: u32) {
    let born = {
        sim.carry += e.rate * dt;
        let n = sim.carry.floor();
        sim.carry -= n;
        n as u32
    };
    for _ in 0..born {
        if sim.alive.len() >= e.max as usize {
            break;
        }
        let p = spawn(e, &mut sim.rng, w, h);
        sim.alive.push(p);
    }
    let mut splashes: Vec<Particle> = Vec::new();
    let room = (e.max as usize).saturating_sub(sim.alive.len());
    let ts = e.turbulence_scale.max(1e-3) * h;
    sim.alive.retain_mut(|p| {
        p.age += dt;
        if p.age >= p.life {
            return false;
        }
        let m = e.depth[0] + (e.depth[1] - e.depth[0]) * p.z;
        // Gravity, and drag toward the wind (the two set a falling speed).
        let g = if p.splash { e.gravity.max(1.0) } else { e.gravity };
        p.vx += e.drag * (e.wind[0] * h - p.vx) * dt;
        p.vy += (g * h + e.drag * (e.wind[1] * h - p.vy)) * dt;
        let (mut mx, mut my) = (p.vx * m, p.vy * m);
        if e.turbulence > 0.0 && !p.splash {
            let (cx, cy) = curl(p.x / ts, p.y / ts, t * e.turbulence_speed + p.phase * 0.01, seed);
            mx += cx * e.turbulence * h * m;
            my += cy * e.turbulence * h * m;
        }
        p.x += mx * dt;
        p.y += my * dt;
        p.mx = mx;
        p.my = my;
        p.rot += p.spin * dt;
        if let Some(gr) = &e.ground {
            if !p.splash && p.y >= (gr.y + gr.spread * p.z) * h {
                for _ in 0..gr.splash {
                    if splashes.len() >= room {
                        break;
                    }
                    let a = std::f32::consts::PI * (1.1 + 0.8 * sim.rng.f());
                    let v = (0.15 + 0.25 * sim.rng.f()) * h * 0.4 * m;
                    splashes.push(Particle {
                        vx: a.cos() * v,
                        vy: a.sin() * v,
                        mx: 0.0,
                        my: 0.0,
                        age: 0.0,
                        life: 0.12 + 0.18 * sim.rng.f(),
                        r: gr.splash_size * h * (0.6 + 0.6 * sim.rng.f()),
                        opacity: p.opacity,
                        splash: true,
                        ..p.clone()
                    });
                }
                return false;
            }
        }
        let margin = 0.6;
        p.x > -margin * w && p.x < (1.0 + margin) * w && p.y > -margin * h && p.y < (1.0 + margin * 0.5) * h
    });
    sim.alive.extend(splashes);
}

fn spawn(e: &Emitter, rng: &mut Rng, w: f32, h: f32) -> Particle {
    let x = (e.area[0] + (e.area[2] - e.area[0]) * rng.f()) * w;
    let y = (e.area[1] + (e.area[3] - e.area[1]) * rng.f()) * h;
    let dir = (e.direction + e.spread * (rng.f() - 0.5)).to_radians();
    let speed = rng.range(e.speed) * h;
    let color = if e.colors.is_empty() { [1.0; 3] } else { e.colors[(rng.next() % e.colors.len() as u64) as usize] };
    let spin = rng.range(e.spin) * if rng.f() < 0.5 { -1.0 } else { 1.0 };
    Particle {
        x,
        y,
        vx: dir.cos() * speed,
        vy: dir.sin() * speed,
        mx: dir.cos() * speed,
        my: dir.sin() * speed,
        age: 0.0,
        life: rng.range(e.life).max(1e-3),
        r: rng.range(e.size) * h,
        opacity: rng.range(e.opacity),
        color,
        // Squared: there are more far particles than near ones, as in a real volume of air.
        z: rng.f().powi(2),
        rot: rng.f() * 360.0,
        spin,
        flip: e.flip * (0.5 + rng.f()),
        phase: rng.f() * 1000.0,
        splash: false,
    }
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Disc,
    Streak,
    Rect,
    Bokeh,
    Ring,
    /// Gaussian blob with its own spread per axis (flare glows and streaks).
    Gauss,
}

#[derive(Clone, Copy, Debug)]
struct Sprite {
    kind: Kind,
    cx: f32,
    cy: f32,
    r: f32,
    soft: f32,
    /// Streak half vector; Gauss spreads (sx, sy); Rect half extents.
    ax: f32,
    ay: f32,
    cos: f32,
    sin: f32,
    color: [f32; 3],
    alpha: f32,
    glow: f32,
    additive: bool,
    bbox: [i32; 4],
}

impl Sprite {
    fn finish(mut self) -> Sprite {
        let reach = match self.kind {
            Kind::Gauss => 0.0,
            _ => self.r + self.soft + self.glow.min(1.0) * 2.5 * (self.r + self.soft),
        };
        let (ex, ey) = match self.kind {
            Kind::Streak => (self.ax.abs() + reach, self.ay.abs() + reach),
            Kind::Rect => {
                let e = (self.ax * self.ax + self.ay * self.ay).sqrt() + self.soft + 1.0;
                (e, e)
            }
            Kind::Gauss => (3.0 * self.ax, 3.0 * self.ay),
            _ => (reach, reach),
        };
        self.bbox = [(self.cx - ex).floor() as i32, (self.cy - ey).floor() as i32, (self.cx + ex).ceil() as i32, (self.cy + ey).ceil() as i32];
        self
    }

    /// How much of this sprite covers the pixel centered at (px, py), 0..1.
    #[inline]
    fn coverage(&self, px: f32, py: f32) -> f32 {
        let (dx, dy) = (px - self.cx, py - self.cy);
        let edge = |d: f32, r: f32| 1.0 - smoothstep(r - self.soft * 0.5, r + self.soft * 0.5, d);
        let halo = |d: f32| {
            if self.glow <= 0.0 {
                return 0.0;
            }
            let s = self.r + self.soft;
            self.glow * (-(d / s).powi(2) * 0.35).exp() * 0.6
        };
        match self.kind {
            Kind::Disc => {
                let d = (dx * dx + dy * dy).sqrt();
                let c = edge(d, self.r);
                c + halo(d) * (1.0 - c)
            }
            Kind::Bokeh => {
                let d = (dx * dx + dy * dy).sqrt();
                edge(d, self.r) * (0.7 + 0.3 * smoothstep(0.55 * self.r, self.r, d))
            }
            Kind::Ring => {
                let d = (dx * dx + dy * dy).sqrt();
                let band = (self.r * 0.12).max(1.0);
                (1.0 - smoothstep(band * 0.5, band * 0.5 + self.soft, (d - self.r).abs())) * 0.8 + 0.2 * edge(d, self.r)
            }
            Kind::Streak => {
                // Distance to the segment from -a to +a.
                let len2 = self.ax * self.ax + self.ay * self.ay;
                let u = if len2 > 1e-6 { ((dx * self.ax + dy * self.ay) / len2).clamp(-1.0, 1.0) } else { 0.0 };
                let (ex, ey) = (dx - u * self.ax, dy - u * self.ay);
                let d = (ex * ex + ey * ey).sqrt();
                let c = edge(d, self.r);
                // Brighter at the head, as a moving drop leaves a fading trail.
                let along = 0.55 + 0.45 * (u + 1.0) * 0.5;
                (c + halo(d) * (1.0 - c)) * along
            }
            Kind::Rect => {
                let (lx, ly) = (dx * self.cos + dy * self.sin, -dx * self.sin + dy * self.cos);
                let (qx, qy) = (lx.abs() - self.ax, ly.abs() - self.ay);
                let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
                let d = outside + qx.max(qy).min(0.0);
                1.0 - smoothstep(-self.soft * 0.5, self.soft * 0.5, d)
            }
            Kind::Gauss => (-0.5 * ((dx / self.ax).powi(2) + (dy / self.ay).powi(2))).exp(),
        }
    }
}

/// Sprites of a particle system's live particles at sim time `t`.
fn particle_sprites(e: &Emitter, sim: &Sim, h: f32, fps: f32, t: f32, seed: u32, out: &mut Vec<Sprite>) {
    for p in &sim.alive {
        let u = (p.age / p.life).clamp(0.0, 1.0);
        let m = e.depth[0] + (e.depth[1] - e.depth[0]) * p.z;
        let mut r = p.r * m * stops(&e.size_over_life, u);
        let mut alpha = p.opacity * stops(&e.opacity_over_life, u);
        if e.flicker > 0.0 {
            let n = noise3(t * e.flicker_rate, p.phase, 0.0, seed ^ 0x51ED);
            alpha *= 1.0 - e.flicker * (1.0 - n);
        }
        let mut color = if e.color_over_life.is_empty() || p.splash { p.color } else { color_stops(&e.color_over_life, u) };
        let blur = e.depth_blur * h * p.z * p.z;
        let mut soft = (e.softness * r).max(0.8) + blur;
        let shape = if p.splash { Shape::Disc } else { e.shape };
        if r < 0.5 {
            // Too thin to draw sharply: keep the light it carries, spread over half a pixel (a streak
            // is thin in one direction only).
            alpha *= if shape == Shape::Streak { r / 0.5 } else { (r / 0.5).powi(2) };
            r = 0.5;
        }
        if blur > 0.0 {
            // A defocused particle spreads the same light over a larger area.
            alpha *= (r / (r + 0.5 * blur)).powi(2).max(0.15);
            soft = soft.max(0.8);
        }
        if alpha <= 1.0 / 512.0 {
            continue;
        }
        let base = Sprite { kind: Kind::Disc, cx: p.x, cy: p.y, r, soft, ax: 0.0, ay: 0.0, cos: 1.0, sin: 0.0, color, alpha, glow: e.glow, additive: e.additive, bbox: [0; 4] };
        let s = match shape {
            Shape::Disc => base,
            Shape::Bokeh => Sprite { kind: Kind::Bokeh, glow: 0.0, ..base },
            Shape::Streak => {
                let k = 0.5 * e.streak / fps;
                Sprite { kind: Kind::Streak, ax: p.mx * k, ay: p.my * k, ..base }
            }
            Shape::Rect => {
                let a = p.rot.to_radians();
                let tumble = (p.flip * t * std::f32::consts::TAU + p.phase).cos();
                // Lit on one side, darker on the other, as a flat piece turns in the light.
                let shade = 0.6 + 0.4 * tumble.abs();
                color = [color[0] * shade, color[1] * shade, color[2] * shade];
                Sprite { kind: Kind::Rect, ax: r * e.aspect * tumble.abs().max(0.12), ay: r, cos: a.cos(), sin: a.sin(), color, glow: 0.0, soft: soft.min(1.2), ..base }
            }
        };
        out.push(s.finish());
    }
}

fn flare_sprites(f: &Flare, frame: usize, w: f32, h: f32, out: &mut Vec<Sprite>) {
    let at = |v: &[f32], d: f32| v.get(frame).or(v.last()).copied().unwrap_or(d);
    let pos = f.positions.get(frame).or(f.positions.last()).copied().unwrap_or([0.5, 0.5]);
    let i = at(&f.intensity, 1.0).max(0.0);
    if i <= 1e-3 {
        return;
    }
    let grow = i.sqrt();
    let (sx, sy) = (pos[0] * w, pos[1] * h);
    let gauss = |cx: f32, cy: f32, ax: f32, ay: f32, color: [f32; 3], alpha: f32| {
        Sprite { kind: Kind::Gauss, cx, cy, r: 0.0, soft: 0.0, ax: ax.max(0.7), ay: ay.max(0.7), cos: 1.0, sin: 0.0, color, alpha: alpha.min(1.0), glow: 0.0, additive: true, bbox: [0; 4] }.finish()
    };
    let white = [1.0, 1.0, 1.0];
    let tint = |c: [f32; 3], k: f32| [c[0] + (1.0 - c[0]) * k, c[1] + (1.0 - c[1]) * k, c[2] + (1.0 - c[2]) * k];
    let r = f.size * h * grow;
    out.push(gauss(sx, sy, r * 1.4, r * 1.4, f.color, 0.35 * i));
    out.push(gauss(sx, sy, r * 0.35, r * 0.35, tint(f.color, 0.7), i));
    out.push(gauss(sx, sy, r * 0.1, r * 0.1, white, i));
    if f.streak > 0.0 {
        out.push(gauss(sx, sy, f.streak * w * grow, (0.0035 * h * grow).max(1.0), f.streak_color, 0.55 * i));
    }
    let (cx, cy) = (0.5 * w, 0.5 * h);
    for g in &f.ghosts {
        let (gx, gy) = (sx + (cx - sx) * g.at, sy + (cy - sy) * g.at);
        let gr = g.size * h * grow;
        let s = Sprite {
            kind: if g.ring { Kind::Ring } else { Kind::Disc },
            cx: gx,
            cy: gy,
            r: gr,
            soft: (gr * 0.35).max(1.0),
            ax: 0.0,
            ay: 0.0,
            cos: 1.0,
            sin: 0.0,
            color: g.color,
            alpha: (g.opacity * i).min(1.0),
            glow: 0.0,
            additive: true,
            bbox: [0; 4],
        };
        out.push(s.finish());
    }
}

/// Density of a noise system on its reduced grid, row-major.
fn noise_grid(n: &Noise, w: usize, h: usize, t: f32, seed: u32) -> (Vec<f32>, Vec<f32>, usize, usize) {
    let ds = n.downscale.max(1) as usize;
    let (gw, gh) = (w.div_ceil(ds) + 1, h.div_ceil(ds) + 1);
    let hf = h as f32;
    let cells: Vec<(f32, f32)> = (0..gw * gh)
        .into_par_iter()
        .map(|k| {
            let (x, y) = (((k % gw) * ds) as f32, ((k / gw) * ds) as f32);
            let (mut keep, mut shade) = (1.0f32, 0.0f32);
            for l in 0..n.layers.max(1) {
                let lf = l as f32;
                // Farther layers are larger and slower.
                let size = n.scale.max(1e-3) * hf * (1.0 + 0.7 * lf);
                let speed = 1.0 / (1.0 + 0.6 * lf);
                let nx = (x - n.drift[0] * hf * t * speed) / size;
                let ny = (y - n.drift[1] * hf * t * speed) / size;
                let v = fbm(nx, ny, t * n.evolve + lf * 17.0, n.octaves, seed.wrapping_add(l * 131));
                let d = smoothstep(n.density[0], n.density[1], v) / (1.0 + 0.35 * lf);
                keep *= 1.0 - d;
                shade += v;
            }
            let fall = n.falloff[0] + (n.falloff[1] - n.falloff[0]) * (y / hf).clamp(0.0, 1.0);
            (((1.0 - keep) * fall * n.opacity).clamp(0.0, 1.0), shade / n.layers.max(1) as f32)
        })
        .collect();
    let (d, s): (Vec<f32>, Vec<f32>) = cells.into_iter().unzip();
    (d, s, gw, ds)
}

const BAND: usize = 16;

/// Draws a spec's frames one after another.
pub struct Renderer {
    spec: Spec,
    frame: usize,
    t: f32,
    sims: Vec<Option<Sim>>,
    accum: Vec<f32>,
    started: bool,
}

impl Renderer {
    pub fn new(spec: Spec) -> Renderer {
        let sims = spec
            .systems
            .iter()
            .enumerate()
            .map(|(k, s)| match s {
                System::Particles(e) => {
                    let mut rng = Rng(spec.seed ^ (0xA076_1D64_78BD_642F_u64.wrapping_mul(k as u64 + 1)));
                    let (w, h) = (spec.width as f32, spec.height as f32);
                    let alive = (0..e.burst.min(e.max)).map(|_| spawn(e, &mut rng, w, h)).collect();
                    Some(Sim { alive, rng, carry: 0.0 })
                }
                _ => None,
            })
            .collect();
        Renderer { spec, frame: 0, t: 0.0, sims, accum: Vec::new(), started: false }
    }

    /// Run the preroll (the first `frames` call does it when this was not called before).
    pub fn start(&mut self) {
        if self.started {
            return;
        }
        self.started = true;
        self.accum = vec![0.0; self.spec.width * self.spec.height * 4];
        let dt = 1.0 / self.spec.fps;
        for _ in 0..(self.spec.preroll * self.spec.fps).round() as usize {
            self.advance(dt);
        }
        self.t = 0.0;
    }

    fn seed(&self, k: usize) -> u32 {
        (self.spec.seed as u32) ^ (k as u32).wrapping_mul(0x9E37_79B9)
    }

    fn advance(&mut self, dt: f32) {
        let (w, h) = (self.spec.width as f32, self.spec.height as f32);
        // Two substeps a frame keep fast particles (rain) steady.
        let sub = dt / 2.0;
        for _ in 0..2 {
            for k in 0..self.spec.systems.len() {
                let seed = self.seed(k);
                if let (System::Particles(e), Some(sim)) = (&self.spec.systems[k], self.sims[k].as_mut()) {
                    step(e, sim, w, h, self.t, sub, seed);
                }
            }
            self.t += sub;
        }
    }

    /// Particles alive now, over all systems.
    pub fn alive(&self) -> usize {
        self.sims.iter().flatten().map(|s| s.alive.len()).sum()
    }

    /// Draw the next `count` frames as straight-alpha RGBA, back to back.
    pub fn frames(&mut self, count: usize) -> Vec<u8> {
        self.start();
        let (w, h) = (self.spec.width, self.spec.height);
        let mut out = vec![0u8; count * w * h * 4];
        for f in 0..count {
            self.draw(&mut out[f * w * h * 4..(f + 1) * w * h * 4]);
            let scale = self.spec.time_scale.get(self.frame).copied().unwrap_or(1.0).max(0.0);
            self.frame += 1;
            self.advance(scale / self.spec.fps);
        }
        out
    }

    fn draw(&mut self, out: &mut [u8]) {
        let (w, h) = (self.spec.width, self.spec.height);
        let (wf, hf) = (w as f32, h as f32);
        let bands = h.div_ceil(BAND);
        enum Layer {
            Sprites(Vec<Sprite>, Vec<Vec<u32>>),
            Noise { density: Vec<f32>, shade: Vec<f32>, gw: usize, ds: usize, color: [f32; 3] },
        }
        let mut layers: Vec<Layer> = Vec::new();
        for (k, s) in self.spec.systems.iter().enumerate() {
            let seed = self.seed(k);
            let mut sprites = Vec::new();
            match s {
                System::Particles(e) => particle_sprites(e, self.sims[k].as_ref().unwrap(), hf, self.spec.fps, self.t, seed, &mut sprites),
                System::Flare(fl) => flare_sprites(fl, self.frame, wf, hf, &mut sprites),
                System::Noise(n) => {
                    let (density, shade, gw, ds) = noise_grid(n, w, h, self.t, seed);
                    layers.push(Layer::Noise { density, shade, gw, ds, color: n.color });
                    continue;
                }
            }
            // Each band lists the sprites that reach into it, in drawing order.
            let mut lists = vec![Vec::new(); bands];
            for (i, sp) in sprites.iter().enumerate() {
                if sp.bbox[2] < 0 || sp.bbox[0] >= w as i32 || sp.bbox[3] < 0 || sp.bbox[1] >= h as i32 {
                    continue;
                }
                let (b0, b1) = (sp.bbox[1].max(0) as usize / BAND, (sp.bbox[3].min(h as i32 - 1)) as usize / BAND);
                for list in &mut lists[b0..=b1] {
                    list.push(i as u32);
                }
            }
            layers.push(Layer::Sprites(sprites, lists));
        }
        let row = w * 4;
        self.accum.par_chunks_mut(BAND * row).zip(out.par_chunks_mut(BAND * row)).enumerate().for_each(|(b, (acc, px))| {
            acc.fill(0.0);
            let y0 = b * BAND;
            let rows = acc.len() / row;
            for layer in &layers {
                match layer {
                    Layer::Sprites(sprites, lists) => {
                        for &i in &lists[b] {
                            let s = &sprites[i as usize];
                            let (ya, yb) = ((s.bbox[1].max(y0 as i32)) as usize, (s.bbox[3].min((y0 + rows) as i32 - 1)) as usize);
                            let (xa, xb) = (s.bbox[0].max(0) as usize, (s.bbox[2].min(w as i32 - 1)) as usize);
                            if ya > yb || xa > xb {
                                continue;
                            }
                            for y in ya..=yb {
                                let line = &mut acc[(y - y0) * row..(y - y0 + 1) * row];
                                for x in xa..=xb {
                                    let a = (s.coverage(x as f32 + 0.5, y as f32 + 0.5) * s.alpha).min(1.0);
                                    if a <= 0.0 {
                                        continue;
                                    }
                                    let p = &mut line[x * 4..x * 4 + 4];
                                    if s.additive {
                                        p[0] += s.color[0] * a;
                                        p[1] += s.color[1] * a;
                                        p[2] += s.color[2] * a;
                                    } else {
                                        let k = 1.0 - a;
                                        p[0] = s.color[0] * a + p[0] * k;
                                        p[1] = s.color[1] * a + p[1] * k;
                                        p[2] = s.color[2] * a + p[2] * k;
                                    }
                                    p[3] = a + p[3] * (1.0 - a);
                                }
                            }
                        }
                    }
                    Layer::Noise { density, shade, gw, ds, color } => {
                        let inv = 1.0 / *ds as f32;
                        for y in 0..rows {
                            let gy = (y0 + y) as f32 * inv;
                            let (j, fy) = (gy.floor() as usize, gy.fract());
                            for x in 0..w {
                                let gx = x as f32 * inv;
                                let (i, fx) = (gx.floor() as usize, gx.fract());
                                let at = |v: &Vec<f32>| {
                                    let (a, b, c, d) = (v[j * gw + i], v[j * gw + i + 1], v[(j + 1) * gw + i], v[(j + 1) * gw + i + 1]);
                                    (a + (b - a) * fx) * (1.0 - fy) + (c + (d - c) * fx) * fy
                                };
                                let a = at(density);
                                if a <= 0.0 {
                                    continue;
                                }
                                // Billows are lighter where the noise is high: a hint of volume.
                                let lit = 0.82 + 0.36 * at(shade);
                                let p = &mut acc[y * row + x * 4..y * row + x * 4 + 4];
                                let k = 1.0 - a;
                                p[0] = (color[0] * lit).min(1.0) * a + p[0] * k;
                                p[1] = (color[1] * lit).min(1.0) * a + p[1] * k;
                                p[2] = (color[2] * lit).min(1.0) * a + p[2] * k;
                                p[3] = a + p[3] * k;
                            }
                        }
                    }
                }
            }
            // Straight alpha out. Added light can exceed the coverage: then it sets the alpha.
            for (p, o) in acc.chunks_exact(4).zip(px.chunks_exact_mut(4)) {
                let a = p[3].max(p[0]).max(p[1]).max(p[2]).min(1.0);
                if a < 1.0 / 512.0 {
                    o.copy_from_slice(&[0, 0, 0, 0]);
                    continue;
                }
                let q = |c: f32| ((c / a).min(1.0) * 255.0 + 0.5) as u8;
                o[0] = q(p[0]);
                o[1] = q(p[1]);
                o[2] = q(p[2]);
                o[3] = (a * 255.0 + 0.5) as u8;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn snow() -> Emitter {
        Emitter {
            area: [-0.2, -0.1, 1.2, -0.02],
            rate: 400.0,
            burst: 0,
            max: 2000,
            life: [6.0, 9.0],
            speed: [0.05, 0.1],
            direction: 90.0,
            spread: 30.0,
            gravity: 0.3,
            wind: [0.05, 0.0],
            drag: 2.0,
            turbulence: 0.08,
            turbulence_scale: 0.2,
            turbulence_speed: 0.3,
            size: [0.0015, 0.004],
            size_over_life: vec![],
            opacity: [0.6, 0.95],
            opacity_over_life: vec![[0.0, 0.0], [0.05, 1.0], [0.9, 1.0], [1.0, 0.0]],
            colors: vec![[1.0, 1.0, 1.0]],
            color_over_life: vec![],
            shape: Shape::Disc,
            softness: 0.5,
            streak: 0.0,
            aspect: 1.0,
            spin: [0.0, 0.0],
            flip: 0.0,
            flicker: 0.0,
            flicker_rate: 0.0,
            glow: 0.0,
            depth: [0.5, 2.5],
            depth_blur: 0.004,
            additive: false,
            ground: None,
        }
    }

    fn spec(systems: Vec<System>, w: usize, h: usize) -> Spec {
        Spec { width: w, height: h, fps: 30.0, seed: 7, preroll: 4.0, time_scale: vec![], systems }
    }

    #[test]
    fn same_seed_same_frames_however_requested() {
        let s = spec(vec![System::Particles(snow())], 320, 180);
        let all = Renderer::new(s.clone()).frames(6);
        let mut r = Renderer::new(s.clone());
        let mut parts = r.frames(2);
        parts.extend(r.frames(4));
        assert_eq!(all, parts);
        let mut other = s;
        other.seed = 8;
        assert_ne!(all, Renderer::new(other).frames(6));
    }

    #[test]
    fn preroll_fills_the_frame() {
        let mut r = Renderer::new(spec(vec![System::Particles(snow())], 320, 180));
        r.start();
        assert!(r.alive() > 1000, "only {} flakes after preroll", r.alive());
        let f = r.frames(1);
        // Flakes in every quarter of the frame, top to bottom.
        for q in 0..4 {
            let rows = (q * 45)..((q + 1) * 45);
            let lit = rows.flat_map(|y| (0..320).map(move |x| (y * 320 + x) * 4 + 3)).filter(|&i| f[i] > 64).count();
            assert!(lit > 20, "quarter {q}: {lit} lit pixels");
        }
    }

    /// One flake, falling from the middle of the top edge.
    fn one_flake() -> Spec {
        let mut e = snow_no_turb();
        (e.rate, e.burst, e.area, e.depth) = (0.0, 1, [0.5, 0.1, 0.5, 0.1], [1.0, 1.0]);
        let mut s = spec(vec![System::Particles(e)], 320, 180);
        s.preroll = 0.0;
        s
    }

    #[test]
    fn time_scale_slows_the_motion() {
        let y = |s: Spec| {
            let mut r = Renderer::new(s);
            r.frames(20);
            r.sims[0].as_ref().unwrap().alive[0].y - 0.1 * 180.0
        };
        let full = y(one_flake());
        let mut slow = one_flake();
        slow.time_scale = vec![0.25; 20];
        let quarter = y(slow);
        assert!(full > 1.0 && (quarter / full - 0.25).abs() < 0.08, "full speed fell {full} px, quarter speed {quarter} px");
    }

    fn snow_no_turb() -> Emitter {
        let mut e = snow();
        e.turbulence = 0.0;
        e
    }

    #[test]
    fn rain_splashes_on_the_ground() {
        let mut e = snow_no_turb();
        e.gravity = 6.0;
        e.speed = [3.0, 3.0];
        e.life = [2.0, 2.0];
        e.ground = Some(Ground { y: 0.8, spread: 0.1, splash: 3, splash_size: 0.002 });
        let mut r = Renderer::new(spec(vec![System::Particles(e)], 320, 180));
        r.frames(3);
        let sim = r.sims[0].as_ref().unwrap();
        assert!(sim.alive.iter().any(|p| p.splash), "no splashes");
        // Nothing falls far below the ground line.
        assert!(sim.alive.iter().filter(|p| !p.splash).all(|p| p.y <= 0.92 * 180.0 + 1.0));
    }

    #[test]
    fn additive_light_sets_alpha_from_brightness() {
        let mut e = snow_no_turb();
        e.additive = true;
        e.colors = vec![[1.0, 0.5, 0.1]];
        e.rate = 0.0;
        e.burst = 1;
        e.area = [0.5, 0.5, 0.5, 0.5];
        e.speed = [0.0, 0.0];
        e.gravity = 0.0;
        e.wind = [0.0, 0.0];
        e.size = [0.05, 0.05];
        e.depth = [1.0, 1.0];
        e.depth_blur = 0.0;
        e.opacity = [1.0, 1.0];
        e.opacity_over_life = vec![];
        let mut s = spec(vec![System::Particles(e)], 200, 200);
        s.preroll = 0.0;
        let f = Renderer::new(s).frames(1);
        let c = (100 * 200 + 100) * 4;
        assert_eq!(&f[c..c + 4], &[255, 128, 26, 255]);
        assert_eq!(&f[0..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn fog_is_thicker_at_the_bottom() {
        let n = Noise { color: [0.8, 0.82, 0.85], opacity: 0.8, scale: 0.4, octaves: 4, drift: [0.03, 0.0], evolve: 0.05, density: [0.3, 0.7], falloff: [0.1, 1.0], layers: 2, downscale: 4 };
        let mut s = spec(vec![System::Noise(n)], 320, 180);
        s.preroll = 0.0;
        let f = &Renderer::new(s).frames(1);
        let mean =|rows: std::ops::Range<usize>| rows.clone().flat_map(|y| (0..320).map(move |x| f[(y * 320 + x) * 4 + 3] as f64)).sum::<f64>() / (rows.len() * 320) as f64;
        let (top, bottom) = (mean(0..30), mean(150..180));
        assert!(bottom > top * 2.0 && bottom > 40.0, "top {top}, bottom {bottom}");
    }

    #[test]
    fn flare_ghosts_sit_on_the_line_through_the_center() {
        let fl = Flare {
            positions: vec![[0.2, 0.25]],
            intensity: vec![1.0],
            color: [1.0, 0.8, 0.5],
            size: 0.05,
            streak: 0.0,
            streak_color: [0.6, 0.8, 1.0],
            ghosts: vec![Ghost { at: 1.6, size: 0.03, color: [0.4, 1.0, 0.6], opacity: 0.6, ring: false }],
        };
        let mut s = spec(vec![System::Flare(fl.clone())], 400, 200);
        s.preroll = 0.0;
        let f = Renderer::new(s.clone()).frames(1);
        let px = |x: usize, y: usize| f[(y * 400 + x) * 4 + 1];
        // Source at (80, 50); the ghost at 1.6 of the way to the center (200, 100): (272, 130).
        assert!(px(80, 50) > 200);
        assert!(px(272, 130) > 60, "ghost {}", px(272, 130));
        assert!(px(272, 130) > 4 * px(272, 60).max(1));
        // Dimmer light: a smaller, fainter flare.
        let mut dim = s;
        dim.systems = vec![System::Flare(Flare { intensity: vec![0.25], ..fl })];
        let g = Renderer::new(dim).frames(1);
        assert!(g[(130 * 400 + 272) * 4 + 3] < f[(130 * 400 + 272) * 4 + 3]);
    }

    #[test]
    fn budget_2000_particles_at_1080p() {
        // Section 6: 1080p, 2,000 particles, under 40 ms a frame. Timed in release builds only.
        if cfg!(debug_assertions) {
            return;
        }
        let mut e = snow();
        // Born faster than the cap allows, so 2,000 are alive throughout.
        e.rate = 800.0;
        let mut r = Renderer::new(spec(vec![System::Particles(e)], 1920, 1080));
        r.start();
        assert!(r.alive() >= 1900, "{} alive", r.alive());
        r.frames(3);
        let t = std::time::Instant::now();
        r.frames(30);
        let ms = t.elapsed().as_secs_f64() * 1000.0 / 30.0;
        println!("2000 particles at 1080p: {ms:.1} ms a frame");
        assert!(ms < 40.0, "{ms:.1} ms a frame");
    }
}
