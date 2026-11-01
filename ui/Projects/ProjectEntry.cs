namespace VideoEditor.Projects;

/// <summary>A project on the projects page: its cover is a frame of the edit, or the default cover when there is none yet.</summary>
public sealed record ProjectEntry(string Name, string Dir, string Updated, string? Cover);
