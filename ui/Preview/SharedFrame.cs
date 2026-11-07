using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Media.Imaging;
using Avalonia.Platform;

namespace VideoEditor.Preview;

/// <summary>
/// Reads frames the render engine writes into a memory-mapped file (native/ave-render/src/shared.rs
/// gives the layout; keep the two in step): a 32-byte header ("AVEF", layout 1, a sequence that is
/// odd while a frame is being written, width, height), then BGRA pixels. Scrubbing then needs no
/// picture files: the pixels are copied straight into the bitmap the viewer shows.
/// </summary>
public sealed class SharedFrameReader : IDisposable
{
    private const int Header = 32;
    private string? _path;
    private MemoryMappedFile? _file;
    private MemoryMappedViewAccessor? _view;
    private long _mapped;
    private byte[] _pixels = [];

    /// <summary>
    /// Copy the frame in <paramref name="path"/> into <paramref name="bitmap"/> (made again when the
    /// size changes). Returns the bitmap, or null when the file holds no complete frame of that size.
    /// </summary>
    public WriteableBitmap? Read(string path, int width, int height, WriteableBitmap? bitmap)
    {
        var size = Header + (long)width * height * 4;
        if (!Map(path, size)) return null;
        var view = _view!;
        if (bitmap is null || bitmap.PixelSize.Width != width || bitmap.PixelSize.Height != height)
            bitmap = new WriteableBitmap(new PixelSize(width, height), new Vector(96, 96), PixelFormat.Bgra8888, AlphaFormat.Opaque);
        // The engine may be writing the next frame: copy again while the sequence is odd or moves.
        for (var attempt = 0; attempt < 4; attempt++)
        {
            var before = view.ReadUInt64(8);
            if (before % 2 == 1 || view.ReadUInt32(16) != width || view.ReadUInt32(20) != height)
            {
                Thread.Sleep(2);
                continue;
            }
            using (var fb = bitmap.Lock()) Copy(view, fb, width, height);
            if (view.ReadUInt64(8) == before) return bitmap;
        }
        return null;
    }

    private void Copy(MemoryMappedViewAccessor view, ILockedFramebuffer fb, int width, int height)
    {
        var row = width * 4;
        var bytes = row * height;
        if (_pixels.Length != bytes) _pixels = new byte[bytes];
        view.ReadArray(Header, _pixels, 0, bytes);
        if (fb.RowBytes == row) Marshal.Copy(_pixels, 0, fb.Address, bytes);
        else
            for (var y = 0; y < height; y++) Marshal.Copy(_pixels, y * row, fb.Address + y * fb.RowBytes, row);
    }

    /// <summary>Map the file, again when it is another one or has grown.</summary>
    private bool Map(string path, long size)
    {
        if (_path == path && _view is not null && _mapped >= size) return true;
        Close();
        try
        {
            // The engine keeps writing the file: open it shared, read only.
            var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (stream.Length < size)
            {
                stream.Dispose();
                return false;
            }
            _file = MemoryMappedFile.CreateFromFile(stream, null, 0, MemoryMappedFileAccess.Read, HandleInheritability.None, leaveOpen: false);
            _view = _file.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
            _mapped = stream.Length;
            _path = path;
            Span<byte> magic = stackalloc byte[4];
            for (var i = 0; i < 4; i++) magic[i] = _view.ReadByte(i);
            if (!magic.SequenceEqual("AVEF"u8) || _view.ReadUInt32(4) != 1)
            {
                Close();
                return false;
            }
            return true;
        }
        catch (IOException)
        {
            Close();
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            Close();
            return false;
        }
    }

    private void Close()
    {
        _view?.Dispose();
        _file?.Dispose();
        _view = null;
        _file = null;
        _path = null;
        _mapped = 0;
    }

    public void Dispose() => Close();
}

/// <summary>A scrubbed frame: a picture file, or <paramref name="Width"/> x <paramref name="Height"/> pixels in a shared frame file.</summary>
public sealed record ScrubFrame(string? Path, string? Shared, int Width, int Height);
