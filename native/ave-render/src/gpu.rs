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
    pub resample_h: wgpu::ComputePipeline,
    pub resample_v: wgpu::ComputePipeline,
    pub primary: wgpu::ComputePipeline,
    pub layer: wgpu::ComputePipeline,
    pub pack: wgpu::ComputePipeline,
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
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PrimaryParams {
    pub mode: u32,
    pub kind: u32,
    pub fade_a: f32,
    pub fade_b: f32,
    pub progress: f32,
    pub _pad: [f32; 3],
    pub background: [f32; 4],
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
        let limits = wgpu::Limits { max_texture_dimension_2d: 8192, ..wgpu::Limits::default() }.using_resolution(adapter.limits());
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
        let pipeline = |m: &wgpu::ShaderModule, entry: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: None,
                module: m,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        Ok(Gpu {
            resample_h: pipeline(&resample, "horizontal"),
            resample_v: pipeline(&resample, "vertical"),
            primary: pipeline(&primary, "main"),
            layer: pipeline(&layer, "main"),
            pack: pipeline(&pack, "main"),
            device,
            queue,
            info,
        })
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

    pub fn upload(&self, texture: &wgpu::Texture, rgba: &[u8], width: u32, height: u32) {
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            rgba,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * width), rows_per_image: Some(height) },
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
        let entries: Vec<wgpu::BindGroupEntry> =
            resources.iter().enumerate().map(|(i, r)| wgpu::BindGroupEntry { binding: i as u32, resource: r.clone() }).collect();
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipeline.get_bind_group_layout(0), entries: &entries });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(width.div_ceil(WORKGROUP), height.div_ceil(WORKGROUP), 1);
    }
}

pub fn view(t: &wgpu::Texture) -> wgpu::TextureView {
    t.create_view(&wgpu::TextureViewDescriptor::default())
}
