namespace VideoEditor.Shared;

/// <summary>
/// Glyphs of the bundled icon font, Fluent UI System Icons (MIT, Assets/Fonts), 20px regular set.
/// The same font on every system, unlike Windows' Segoe Fluent Icons.
/// </summary>
public static class Icons
{
    private static string G(int codePoint) => char.ConvertFromUtf32(codePoint);

    public static readonly string Video = G(63564);
    public static readonly string Folder = G(62488);
    public static readonly string FolderOpen = G(62510);
    public static readonly string Add = G(61705);
    public static readonly string Undo = G(61849);
    public static readonly string Redo = G(61806);
    public static readonly string Grid = G(62562);
    public static readonly string Play = G(62981);
    public static readonly string Pause = G(62881);
    public static readonly string Stop = G(63274);
    public static readonly string Check = G(62100);
    public static readonly string Error = G(62449);
    public static readonly string Warning = G(63593);
    public static readonly string Info = G(62627);
    public static readonly string Dismiss = G(62313);
    public static readonly string Sync = G(61840);
    public static readonly string Wrench = G(61062);
    public static readonly string Open = G(62850);
    public static readonly string Location = G(62712);
    public static readonly string Send = G(61851);
    public static readonly string ChevronUp = G(62134);
    public static readonly string ChevronDown = G(62115);
    public static readonly string Export = G(57543);
    public static readonly string Review = G(60562);
}
