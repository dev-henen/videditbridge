//! The GPU through wgpu (Direct3D 12, Metal or Vulkan): the device and the compute pipelines.
//! Pictures live in rgba16float textures between passes.

use bytemuck::{Pod, Zeroable};
use serde_json::{json, Value};
use wgpu::util::DeviceExt;

pub const WORKGROUP: u32 = 16;
pub const FLOAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: wgpu::AdapterInfo,
    /** The shader modules, by name; their pipelines are built from them on first use (`pipeline`). */
    modules: std::collections::HashMap<&'static str, wgpu::ShaderModule>,
    /** Each pipeline: its module and entry point, and the pipeline once built. */
    pipelines: Vec<(&'static str, &'static str, std::sync::OnceLock<wgpu::ComputePipeline>)>,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct ConvParams {
    pub size: u32,
    pub rgb: u32,
    pub rdiv: f32,
    pub bias: f32,
    /// 0 convolution, 1 unsharp on luma (`height` rows of weights summing to 2^scalebits).
    pub mode: u32,
    pub amount: i32,
    pub height: u32,
    pub scalebits: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CombineParams {
    pub mode: u32,
    pub luma: u32,
    pub opacity: f32,
    pub _pad: f32,
    pub color: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct LightParams {
    pub mode: u32,
    pub count: u32,
    pub t: f32,
    pub _pad: f32,
    pub speeds: [f32; 4],
    pub speed5: f32,
    pub _pad2: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct ResampleParams {
    pub src_len: u32,
    pub scaled_len: u32,
    pub offset: i32,
    pub opaque: u32,
    pub out_size: [u32; 2],
    pub x_range: [i32; 2],
    pub fill: [f32; 4],
    pub origin: i32,
    pub line_origin: i32,
    pub yuv_in: u32,
    pub _pad: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default)]
pub struct PixelParams {
    pub mode: u32,
    pub backward: u32,
    pub shift_red: [i32; 2],
    pub shift_green: [i32; 2],
    pub shift_blue: [i32; 2],
    pub rect: [f32; 4],
    pub color: [f32; 4],
    pub angle: f32,
    pub factor: f32,
    pub bar: u32,
    pub frame: u32,
    pub strength: f32,
    pub uniform: u32,
    pub _pad: [u32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct BlurParams {
    pub nu: [f32; 4],
    pub boundary: [f32; 4],
    pub post: [f32; 4],
    pub nu_v: [f32; 4],
    pub boundary_v: [f32; 4],
    pub size: [u32; 2],
    pub _pad: [u32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PrimaryParams {
    pub mode: u32,
    pub kind: u32,
    pub fade_a: f32,
    pub fade_b: f32,
    pub progress: f32,
    pub reach: f32,
    pub aspect: f32,
    pub rgb: u32,
    pub background: [f32; 4],
    pub origin: [f32; 2],
    pub _pad1: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct HblurParams {
    pub fade_a: f32,
    pub fade_b: f32,
    pub width: u32,
    pub height: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PlanarParams {
    pub opaque: u32,
    pub alpha: u32,
    pub yuv_out: u32,
    pub _pad: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct LayerParams {
    pub pos: [i32; 2],
    pub size: [u32; 2],
    pub blend: u32,
    pub opacity: f32,
    pub _pad: [f32; 2],
}

impl Gpu {
    pub fn new() -> Result<Gpu, String> {
        // Only the system's own API (WGPU_BACKEND overrides): probing every backend loads Vulkan
        // drivers on Windows too, and an old Intel one crashes the process there.
        let native = if cfg!(windows) {
            wgpu::Backends::DX12
        } else if cfg!(target_os = "macos") {
            wgpu::Backends::METAL
        } else {
            wgpu::Backends::VULKAN | wgpu::Backends::GL
        };
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle_from_env();
        desc.backends = wgpu::Backends::from_env().unwrap_or(native);
        let instance = wgpu::Instance::new(desc);
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .map_err(|e| format!("no usable graphics adapter: {e}"))?;
        let info = adapter.get_info();
        // The blur keeps a whole frame of float YUV in a storage buffer: 132 MB at 4K.
        let most = adapter.limits();
        let limits = wgpu::Limits {
            max_texture_dimension_2d: 8192,
            max_storage_buffer_binding_size: most.max_storage_buffer_binding_size,
            max_buffer_size: most.max_buffer_size,
            ..wgpu::Limits::default()
        }
        .using_resolution(most);
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("ave-render"),
            required_limits: limits,
            ..Default::default()
        }))
        .map_err(|e| format!("cannot open the graphics device {}: {e}", info.name))?;
        let module = |label: &str, source: &str| device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(label), source: wgpu::ShaderSource::Wgsl(source.into()) });
        let resample = module("resample", concat!(include_str!("shaders/yuv.wgsl"), include_str!("shaders/resample.wgsl")));
        let primary = module("primary", concat!(include_str!("shaders/yuv.wgsl"), include_str!("shaders/primary.wgsl")));
        let layer = module("layer", include_str!("shaders/layer.wgsl"));
        let pack = module("pack", concat!(include_str!("shaders/yuv.wgsl"), include_str!("shaders/pack.wgsl")));
        let planar = module("planar", concat!(include_str!("shaders/yuv.wgsl"), include_str!("shaders/planar.wgsl")));
        let grade = module("grade", include_str!("shaders/grade.wgsl"));
        let lut = module("lut", include_str!("shaders/lut.wgsl"));
        let hblur = module("hblur", include_str!("shaders/hblur.wgsl"));
        let pixel = module("pixel", concat!(include_str!("shaders/yuv.wgsl"), include_str!("shaders/pixel.wgsl")));
        let blur = module("blur", concat!(include_str!("shaders/yuv.wgsl"), include_str!("shaders/blur.wgsl")));
        let combine = module("combine", concat!(include_str!("shaders/yuv.wgsl"), include_str!("shaders/combine.wgsl")));
        let light = module("light", include_str!("shaders/light.wgsl"));
        let conv = module("conv", concat!(include_str!("shaders/yuv.wgsl"), include_str!("shaders/conv.wgsl")));
        Ok(Gpu {
            modules: [("resample", resample), ("primary", primary), ("layer", layer), ("pack", pack), ("planar", planar), ("grade", grade), ("lut", lut), ("hblur", hblur), ("pixel", pixel), ("blur", blur), ("combine", combine), ("light", light), ("conv", conv)].into_iter().collect(),
            pipelines: vec![
                ("resample", "horizontal", std::sync::OnceLock::new()),
                ("resample", "vertical", std::sync::OnceLock::new()),
                ("primary", "main", std::sync::OnceLock::new()),
                ("layer", "main", std::sync::OnceLock::new()),
                ("pack", "luma", std::sync::OnceLock::new()),
                ("pack", "chroma", std::sync::OnceLock::new()),
                ("planar", "main", std::sync::OnceLock::new()),
                ("grade", "main", std::sync::OnceLock::new()),
                ("lut", "main", std::sync::OnceLock::new()),
                ("hblur", "main", std::sync::OnceLock::new()),
                ("pixel", "main", std::sync::OnceLock::new()),
                ("blur", "load_yuv", std::sync::OnceLock::new()),
                ("blur", "rows", std::sync::OnceLock::new()),
                ("blur", "columns", std::sync::OnceLock::new()),
                ("blur", "store_rgb", std::sync::OnceLock::new()),
                ("blur", "load_rgb", std::sync::OnceLock::new()),
                ("blur", "store_raw", std::sync::OnceLock::new()),
                ("combine", "main", std::sync::OnceLock::new()),
                ("light", "main", std::sync::OnceLock::new()),
                ("conv", "main", std::sync::OnceLock::new()),
            ],
            device,
            queue,
            info,
        })
    }

    /**
     * Pipeline `k` (in the order of the getters below), built on first use. The driver compiles each
     * one (about half a second on an Intel laptop GPU under Direct3D 12): building all twenty at
     * start took 11 s, paid at every start of the engine, which renders start each time.
     */
    fn pipeline(&self, k: usize) -> &wgpu::ComputePipeline {
        let (module, entry, cell) = &self.pipelines[k];
        cell.get_or_init(|| {
            self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: None,
                module: &self.modules[module],
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        })
    }

    /** Start building every pipeline on threads at once, so work that comes next finds them ready (or waits only for its own). */
    pub fn warm(&'static self) {
        for k in 0..self.pipelines.len() {
            std::thread::spawn(move || {
                self.pipeline(k);
            });
        }
    }

    pub fn resample_h(&self) -> &wgpu::ComputePipeline {
        self.pipeline(0)
    }

    pub fn resample_v(&self) -> &wgpu::ComputePipeline {
        self.pipeline(1)
    }

    pub fn primary(&self) -> &wgpu::ComputePipeline {
        self.pipeline(2)
    }

    pub fn layer(&self) -> &wgpu::ComputePipeline {
        self.pipeline(3)
    }

    pub fn pack_luma(&self) -> &wgpu::ComputePipeline {
        self.pipeline(4)
    }

    pub fn pack_chroma(&self) -> &wgpu::ComputePipeline {
        self.pipeline(5)
    }

    pub fn planar(&self) -> &wgpu::ComputePipeline {
        self.pipeline(6)
    }

    pub fn grade(&self) -> &wgpu::ComputePipeline {
        self.pipeline(7)
    }

    pub fn lut(&self) -> &wgpu::ComputePipeline {
        self.pipeline(8)
    }

    pub fn hblur(&self) -> &wgpu::ComputePipeline {
        self.pipeline(9)
    }

    pub fn pixel(&self) -> &wgpu::ComputePipeline {
        self.pipeline(10)
    }

    pub fn blur_load(&self) -> &wgpu::ComputePipeline {
        self.pipeline(11)
    }

    pub fn blur_rows(&self) -> &wgpu::ComputePipeline {
        self.pipeline(12)
    }

    pub fn blur_columns(&self) -> &wgpu::ComputePipeline {
        self.pipeline(13)
    }

    pub fn blur_store(&self) -> &wgpu::ComputePipeline {
        self.pipeline(14)
    }

    pub fn blur_load_rgb(&self) -> &wgpu::ComputePipeline {
        self.pipeline(15)
    }

    pub fn blur_store_raw(&self) -> &wgpu::ComputePipeline {
        self.pipeline(16)
    }

    pub fn combine(&self) -> &wgpu::ComputePipeline {
        self.pipeline(17)
    }

    pub fn light(&self) -> &wgpu::ComputePipeline {
        self.pipeline(18)
    }

    pub fn conv(&self) -> &wgpu::ComputePipeline {
        self.pipeline(19)
    }

    pub fn describe(&self) -> Value {
        json!({
            "adapter": self.info.name,
            "backend": format!("{:?}", self.info.backend),
            "deviceType": format!("{:?}", self.info.device_type),
            "driver": self.info.driver,
        })
    }

    pub fn texture(&self, label: &str, width: u32, height: u32, format: wgpu::TextureFormat, storage: bool) -> wgpu::Texture {
        let usage = wgpu::TextureUsages::TEXTURE_BINDING
            | if storage { wgpu::TextureUsages::STORAGE_BINDING } else { wgpu::TextureUsages::COPY_DST };
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: width.max(1), height: height.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        })
    }

    /// A color table, `size` points per channel, from RGBA bytes with red fastest.
    pub fn table(&self, rgba: &[u8], size: u32) -> wgpu::Texture {
        let t = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("table"),
            size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: size },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            rgba,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * size), rows_per_image: Some(size) },
            wgpu::Extent3d { width: size, height: size, depth_or_array_layers: size },
        );
        t
    }

    /// A float color table, `size` points per channel, from half-float RGBA bits with red fastest.
    pub fn table_half(&self, rgba: &[u16], size: u32) -> wgpu::Texture {
        let t = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("cube"),
            size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: size },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            bytemuck::cast_slice(rgba),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(8 * size), rows_per_image: Some(size) },
            wgpu::Extent3d { width: size, height: size, depth_or_array_layers: size },
        );
        t
    }

    pub fn upload(&self, texture: &wgpu::Texture, rgba: &[u8], width: u32, height: u32) {
        self.upload_pixels(texture, rgba, width, height, 4);
    }

    /// Upload `width` x `height` pixels of `bytes_per_pixel` bytes each, rows packed.
    pub fn upload_pixels(&self, texture: &wgpu::Texture, pixels: &[u8], width: u32, height: u32, bytes_per_pixel: u32) {
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &pixels[..(bytes_per_pixel * width * height) as usize],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bytes_per_pixel * width), rows_per_image: Some(height) },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
    }

    pub fn uniform<T: Pod>(&self, value: &T) -> wgpu::Buffer {
        self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::bytes_of(value),
            usage: wgpu::BufferUsages::UNIFORM,
        })
    }

    /// Record one compute pass over a `width` x `height` grid, binding `resources` in order.
    pub fn dispatch(&self, encoder: &mut wgpu::CommandEncoder, pipeline: &wgpu::ComputePipeline, resources: &[wgpu::BindingResource], width: u32, height: u32) {
        let numbered: Vec<(u32, wgpu::BindingResource)> = resources.iter().enumerate().map(|(i, r)| (i as u32, r.clone())).collect();
        self.dispatch_bound(encoder, pipeline, &numbered, width.div_ceil(WORKGROUP), height.div_ceil(WORKGROUP));
    }

    /// Record one compute pass of `groups_x` x `groups_y` workgroups, binding only the numbered resources its entry point uses.
    pub fn dispatch_bound(&self, encoder: &mut wgpu::CommandEncoder, pipeline: &wgpu::ComputePipeline, resources: &[(u32, wgpu::BindingResource)], groups_x: u32, groups_y: u32) {
        let entries: Vec<wgpu::BindGroupEntry> = resources.iter().map(|(i, r)| wgpu::BindGroupEntry { binding: *i, resource: r.clone() }).collect();
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipeline.get_bind_group_layout(0), entries: &entries });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(groups_x, groups_y, 1);
    }
}

pub fn view(t: &wgpu::Texture) -> wgpu::TextureView {
    t.create_view(&wgpu::TextureViewDescriptor::default())
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct GradeParams {
    pub gains: [f32; 4],
    pub shadows: [f32; 4],
    pub midtones: [f32; 4],
    pub highlights: [f32; 4],
    pub contrast: f32,
    pub saturation: f32,
    pub _pad: [f32; 2],
}
