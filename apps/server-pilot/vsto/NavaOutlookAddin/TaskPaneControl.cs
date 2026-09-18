using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace NavaOutlookAddin
{
    public partial class TaskPaneControl : UserControl
    {
        private const string PaneOriginHost = "nava.legacyhotels.co.za";
        private const string PaneUrl = "https://nava.legacyhotels.co.za/outlook-pane";

        private readonly OutlookBridgeDispatcher _dispatcher;
        private WebView2 _webView;

        public TaskPaneControl(Microsoft.Office.Interop.Outlook.Application application)
        {
            _dispatcher = new OutlookBridgeDispatcher(application);
            InitializeComponent();
            this.Load += TaskPaneControl_Load;
        }

        private void TaskPaneControl_Load(object sender, EventArgs e)
        {
            if (_webView != null) return;
            InitializeWebView();
        }

        private async void InitializeWebView()
        {
            try
            {
                EnsureNativeLoader();
                _webView = new WebView2 { Dock = DockStyle.Fill };
                this.Controls.Add(_webView);

                string userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "NavaOutlookAddin", "WebView2Profile"
                );
                Directory.CreateDirectory(userDataFolder);

                var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await _webView.EnsureCoreWebView2Async(env);

                _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _webView.CoreWebView2.NavigationStarting += CoreWebView2_NavigationStarting;
                _webView.CoreWebView2.WebMessageReceived += CoreWebView2_WebMessageReceived;
                _webView.Source = new Uri(PaneUrl);
            }
            catch (Exception ex)
            {
                ShowPaneError(ex);
            }
        }

        private static void EnsureNativeLoader()
        {
            string cacheDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (string.IsNullOrEmpty(cacheDir))
            {
                throw new InvalidOperationException("Add-in directory is unknown.");
            }
            string rid = Environment.Is64BitProcess ? "win-x64" : "win-x86";
            string dest = Path.Combine(cacheDir, "WebView2Loader.dll");
            string installDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "NavaOutlookAddin");
            string[] sources =
            {
                Path.Combine(installDir, "runtimes", rid, "native", "WebView2Loader.dll"),
                Path.Combine(cacheDir, "runtimes", rid, "native", "WebView2Loader.dll"),
            };
            string src = null;
            foreach (string candidate in sources)
            {
                if (File.Exists(candidate))
                {
                    src = candidate;
                    break;
                }
            }
            if (src == null)
            {
                throw new FileNotFoundException(
                    "Missing WebView2Loader.dll. Tried: " + string.Join("; ", sources));
            }
            if (!File.Exists(dest))
            {
                File.Copy(src, dest, false);
            }
        }

        private void ShowPaneError(Exception ex)
        {
            this.Controls.Clear();
            this.Controls.Add(new Label
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(12),
                Text = "Nava could not start the side pane.\n\n" + ex.Message
            });
        }

        private void CoreWebView2_NavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (!IsTrustedPaneOrigin(e.Uri))
            {
                e.Cancel = true;
            }
        }

        private void CoreWebView2_WebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!IsTrustedPaneOrigin(_webView?.Source?.ToString() ?? "") &&
                !IsTrustedPaneOrigin(e.Source))
            {
                return;
            }

            string message = e.TryGetWebMessageAsString();
            if (!string.IsNullOrEmpty(message))
            {
                string responseJson = _dispatcher.Dispatch(message);
                _webView.CoreWebView2.PostWebMessageAsString(responseJson);
            }
        }

        public void NotifySelectionChanged()
        {
            if (_webView != null && _webView.CoreWebView2 != null)
            {
                var activeMail = _dispatcher.GetActiveEmail(false);
                var serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
                var evt = new Dictionary<string, object>
                {
                    { "requestId", "evt_selection_" + Guid.NewGuid().ToString("N") },
                    { "version", 1 },
                    { "action", "ON_SELECTION_CHANGED" },
                    { "success", true },
                    { "data", activeMail }
                };
                _webView.CoreWebView2.PostWebMessageAsString(serializer.Serialize(evt));
            }
        }

        internal static bool IsTrustedPaneOrigin(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return false;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return false;
            return parsed.Scheme == Uri.UriSchemeHttps &&
                   parsed.Host.Equals(PaneOriginHost, StringComparison.OrdinalIgnoreCase);
        }

        private void InitializeComponent()
        {
            this.SuspendLayout();
            this.Name = "TaskPaneControl";
            this.Size = new System.Drawing.Size(380, 700);
            this.ResumeLayout(false);
        }
    }
}
