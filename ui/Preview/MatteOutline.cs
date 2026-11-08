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

        // The edge: selected pixels with an unselected neighbor.
        var edge = new bool[w * h];
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
                if (on[y * w + x] && (!At(x - 1, y) || !At(x + 1, y) || !At(x, y - 1) || !At(x, y + 1))) edge[y * w + x] = true;

        // A line about a 320th of the picture wide each side of the edge, so it reads at any viewer size.
        var r = Math.Max(1, (int)Math.Round(w / 320.0));
        var bmp = new WriteableBitmap(size, new Vector(96, 96), PixelFormat.Bgra8888, AlphaFormat.Premul);
        using var fb = bmp.Lock();
        var dst = new byte[fb.RowBytes * h];
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
            {
                if (!edge[y * w + x]) continue;
                for (var ny = Math.Max(0, y - r); ny <= Math.Min(h - 1, y + r); ny++)
                    for (var nx = Math.Max(0, x - r); nx <= Math.Min(w - 1, x + r); nx++)
                    {
                        var k = ny * fb.RowBytes + nx * 4;
                        (dst[k], dst[k + 1], dst[k + 2], dst[k + 3]) = (color.B, color.G, color.R, 255);
                    }
            }
        Marshal.Copy(dst, 0, fb.Address, dst.Length);
        return bmp;
    }
}
