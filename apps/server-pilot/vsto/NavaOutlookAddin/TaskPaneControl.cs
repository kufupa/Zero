using System;
using System.Collections.Generic;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
using Outlook = Microsoft.Office.Interop.Outlook;

namespace NavaOutlookAddin
{
    public partial class TaskPaneControl : UserControl
    {
        private readonly OutlookBridgeDispatcher _dispatcher;
        private WebView2 _webView;

        public TaskPaneControl(Outlook.Application application)
        {
            _dispatcher = new OutlookBridgeDispatcher(application);
            InitializeComponent();
            InitializeWebView();
        }

        private async void InitializeWebView()
        {
            _webView = new WebView2 { Dock = DockStyle.Fill };
            this.Controls.Add(_webView);

            string userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "NavaOutlookAddin", "WebView2Profile"
            );
            Directory.CreateDirectory(userDataFolder);

            var env = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, userDataFolder);
            await _webView.EnsureCoreWebView2Async(env);

            _webView.CoreWebView2.WebMessageReceived += CoreWebView2_WebMessageReceived;
            _webView.Source = new Uri("https://nava.legacyhotels.co.za/outlook-pane");
        }

        private void CoreWebView2_WebMessageReceived(object sender, Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs e)
        {
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
                var activeMail = _dispatcher.GetActiveEmail();
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

        private void InitializeComponent()
        {
            this.SuspendLayout();
            this.Name = "TaskPaneControl";
            this.Size = new System.Drawing.Size(380, 700);
            this.ResumeLayout(false);
        }
    }
}
