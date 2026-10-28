namespace VideoEditor.Preview;

/// <summary>A spot clicked in the frame: x and y as fractions of the frame (0,0 top left), at a timeline time.</summary>
public sealed record Spot(double X, double Y, double Time);
