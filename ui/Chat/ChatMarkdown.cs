using System.Text.RegularExpressions;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Media;

namespace VideoEditor.Chat;

/// <summary>
/// Draws a reply's Markdown in a text block: bullets and numbered lists, headings, bold, italics,
/// inline code and code blocks. Models write Markdown whatever they are told, so the chat shows it
/// as formatting instead of stars, dashes and backticks. Set <c>chat:ChatMarkdown.Text</c> in place
/// of <c>Text</c>; it redraws as a reply streams in.
/// </summary>
public static partial class ChatMarkdown
{
    public static readonly AttachedProperty<string?> TextProperty =
        AvaloniaProperty.RegisterAttached<TextBlock, string?>("Text", typeof(ChatMarkdown));

    public static string? GetText(TextBlock block) => block.GetValue(TextProperty);
    public static void SetText(TextBlock block, string? value) => block.SetValue(TextProperty, value);

    static ChatMarkdown()
    {
        TextProperty.Changed.AddClassHandler<TextBlock>((block, e) => Render(block, e.NewValue as string ?? ""));
    }

    private static readonly FontFamily Mono = new("Cascadia Mono, Consolas, Menlo, DejaVu Sans Mono, monospace");
    private static readonly IBrush CodeBrush = new SolidColorBrush(Color.Parse("#D4D4D4"));
    private static readonly IBrush CodeBackground = new SolidColorBrush(Color.Parse("#2C2C2C"));

    [GeneratedRegex(@"^(\s*)([-*+])\s+(.*)$")]
    private static partial Regex Bullet();
    [GeneratedRegex(@"^(\s*)(\d+)[.)]\s+(.*)$")]
    private static partial Regex Numbered();
    [GeneratedRegex(@"^(#{1,6})\s+(.*?)\s*#*\s*$")]
    private static partial Regex Heading();
    [GeneratedRegex(@"^\s*([-*_])(\s*\1){2,}\s*$")]
    private static partial Regex Rule();
    // Inline: `code`, **bold** or __bold__, *italic* or _italic_ (an underscore only between non-word characters).
    [GeneratedRegex(@"`([^`\n]+)`|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\*)|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)")]
    private static partial Regex Inline();

    private static void Render(TextBlock block, string text)
    {
        var inlines = new InlineCollection();
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var inCode = false;
        var first = true;
        void Break()
        {
            if (!first) inlines.Add(new LineBreak());
            first = false;
        }

        foreach (var raw in lines)
        {
            var line = raw.TrimEnd();
            if (line.TrimStart().StartsWith("```"))
            {
                inCode = !inCode;
                continue;
            }
            Break();
            if (inCode)
            {
                inlines.Add(new Run(line.Length == 0 ? " " : line) { FontFamily = Mono, Foreground = CodeBrush, Background = CodeBackground });
                continue;
            }
            if (Rule().IsMatch(line)) continue;
            if (Heading().Match(line) is { Success: true } h)
            {
                AddInline(inlines, h.Groups[2].Value, FontWeight.SemiBold);
                continue;
            }
            if (Bullet().Match(line) is { Success: true } b)
            {
                inlines.Add(new Run(Indent(b.Groups[1].Value) + "•  "));
                AddInline(inlines, b.Groups[3].Value);
                continue;
            }
            if (Numbered().Match(line) is { Success: true } n)
            {
                inlines.Add(new Run($"{Indent(n.Groups[1].Value)}{n.Groups[2].Value}.  "));
                AddInline(inlines, n.Groups[3].Value);
                continue;
            }
            AddInline(inlines, line);
        }
        block.Inlines = inlines;
    }

    /// <summary>Nested list items step in by a few spaces per level.</summary>
    private static string Indent(string lead) => new(' ', Math.Min(lead.Replace("\t", "    ").Length / 2, 6) * 2 + (lead.Length > 0 ? 2 : 0));

    private static void AddInline(InlineCollection inlines, string text, FontWeight? weight = null)
    {
        var at = 0;
        foreach (Match m in Inline().Matches(text))
        {
            if (m.Index > at) inlines.Add(Plain(text[at..m.Index], weight));
            if (m.Groups[1].Success)
                inlines.Add(new Run(m.Groups[1].Value) { FontFamily = Mono, Foreground = CodeBrush, Background = CodeBackground });
            else if (m.Groups[2].Success || m.Groups[3].Success)
                inlines.Add(new Run(m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value) { FontWeight = FontWeight.SemiBold });
            else
                inlines.Add(new Run(m.Groups[4].Success ? m.Groups[4].Value : m.Groups[5].Value) { FontStyle = FontStyle.Italic, FontWeight = weight ?? FontWeight.Normal });
            at = m.Index + m.Length;
        }
        if (at < text.Length) inlines.Add(Plain(text[at..], weight));
    }

    private static Run Plain(string text, FontWeight? weight) => weight is { } w ? new Run(text) { FontWeight = w } : new Run(text);
}
