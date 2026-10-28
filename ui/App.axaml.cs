using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Media;

using VideoEditor.Shell;

namespace VideoEditor;

public partial class App : Application
{
    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
        // Segoe UI is Windows' own UI font and may not be shipped elsewhere; other systems get the bundled Inter (OFL).
        Resources["UiFont"] = OperatingSystem.IsWindows()
            ? new FontFamily("Segoe UI Variable Text, Segoe UI")
            : new FontFamily("fonts:Inter#Inter");
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
            desktop.MainWindow = new MainWindow(desktop.Args ?? []);
        base.OnFrameworkInitializationCompleted();
    }
}
