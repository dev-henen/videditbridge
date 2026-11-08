using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform;

namespace VideoEditor.Preview;

/// <summary>
/// The outline of a matte (white on black), as a picture to lay over the frame: the edge of what the
/// matte selects, two pixels wide, in one color, clear everywhere else. It shows which object Claude
/// selected without hiding the picture.
/// </summary>
public static class MatteOutline
{
    public static WriteableBitmap From(Bitmap matte, Color color)
    {
        var size = matte.PixelSize;
        int w = size.Width, h = size.Height, stride = w * 4;
        var src = new byte[stride * h];
        var pin = GCHandle.Alloc(src, GCHandleType.Pinned);
        try { matte.CopyPixels(new PixelRect(size), pin.AddrOfPinnedObject(), src.Length, stride); }
        finally { pin.Free(); }

        // Selected: the green channel (the same byte in BGRA and RGBA) at half or more.
        var on = new bool[w * h];
        for (var i = 0; i < w * h; i++) on[i] = src[i * 4 + 1] >= 128;
        bool At(int x, int y) => x >= 0 && y >= 0 && x < w && y < h && on[y * w + x];

        // The edge: selected pixels with an unselected neighbor, then grown by a pixel.
        var edge = new bool[w * h];
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
                if (on[y * w + x] && (!At(x - 1, y) || !At(x + 1, y) || !At(x, y - 1) || !At(x, y + 1))) edge[y * w + x] = true;

        var bmp = new WriteableBitmap(size, new Vector(96, 96), PixelFormat.Bgra8888, AlphaFormat.Premul);
        using var fb = bmp.Lock();
        var dst = new byte[fb.RowBytes * h];
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
            {
                var near = false;
                for (var dy = -1; dy <= 1 && !near; dy++)
                    for (var dx = -1; dx <= 1 && !near; dx++)
                    {
                        var (nx, ny) = (x + dx, y + dy);
                        near = nx >= 0 && ny >= 0 && nx < w && ny < h && edge[ny * w + nx];
                    }
                if (!near) continue;
                var k = y * fb.RowBytes + x * 4;
                (dst[k], dst[k + 1], dst[k + 2], dst[k + 3]) = (color.B, color.G, color.R, 255);
            }
        Marshal.Copy(dst, 0, fb.Address, dst.Length);
        return bmp;
    }
}
