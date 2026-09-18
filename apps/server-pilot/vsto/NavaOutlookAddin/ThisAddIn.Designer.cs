//------------------------------------------------------------------------------
// VSTO designer partial. Visual Studio regenerates this when the Office
// Developer Tools are installed; keep the host-item and Globals wiring so a
// Windows Release build can emit NavaOutlookAddin.dll + .vsto.
//------------------------------------------------------------------------------

#pragma warning disable 414
namespace NavaOutlookAddin
{
    [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
    public sealed partial class ThisAddIn : Microsoft.Office.Tools.Outlook.OutlookAddInBase
    {
        [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
        internal Microsoft.Office.Interop.Outlook.Application Application;

        [System.Diagnostics.DebuggerNonUserCodeAttribute()]
        [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
        public ThisAddIn(Microsoft.Office.Tools.Outlook.Factory factory, System.IServiceProvider serviceProvider)
            : base(factory, serviceProvider, "AddIn", "ThisAddIn")
        {
            Globals.Factory = factory;
        }

        [System.Diagnostics.DebuggerNonUserCodeAttribute()]
        [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
        protected override void Initialize()
        {
            base.Initialize();
            this.Application = this.GetHostItem<Microsoft.Office.Interop.Outlook.Application>(
                typeof(Microsoft.Office.Interop.Outlook.Application),
                "Application");
            Globals.ThisAddIn = this;
            System.Windows.Forms.Application.EnableVisualStyles();
            this.InitializeCachedData();
            this.InitializeControls();
            this.InitializeComponents();
            this.InitializeData();
        }

        [System.Diagnostics.DebuggerNonUserCodeAttribute()]
        [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
        protected override void FinishInitialization()
        {
            this.InternalStartup();
            this.OnStartup();
        }

        [System.Diagnostics.DebuggerNonUserCodeAttribute()]
        [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
        protected override void InitializeDataBindings()
        {
            this.BeginInitialization();
            this.BindToData();
            this.EndInitialization();
        }

        [System.Diagnostics.DebuggerNonUserCodeAttribute()]
        [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
        private void InitializeCachedData()
        {
            if (this.DataHost == null) return;
            if (this.DataHost.IsCacheInitialized)
            {
                this.DataHost.InitializeCachedData();
            }
        }

        [System.Diagnostics.DebuggerNonUserCodeAttribute()]
        [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
        private void InitializeData()
        {
        }

        [System.Diagnostics.DebuggerNonUserCodeAttribute()]
        [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
        private void BindToData()
        {
        }

        [System.Diagnostics.DebuggerNonUserCodeAttribute()]
        [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
        private void BeginInitialization()
        {
            this.BeginInit();
        }

        [System.Diagnostics.DebuggerNonUserCodeAttribute()]
        [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
        private void EndInitialization()
        {
            this.EndInit();
        }

        [System.Diagnostics.DebuggerNonUserCodeAttribute()]
        [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
        private void InitializeControls()
        {
        }

        [System.Diagnostics.DebuggerNonUserCodeAttribute()]
        [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
        private void InitializeComponents()
        {
        }
    }

    [System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Tools.Office.ProgrammingModel.dll", "10.0.0.0")]
    internal sealed partial class Globals
    {
        private static ThisAddIn _ThisAddIn;
        private static Microsoft.Office.Tools.Outlook.Factory _factory;

        internal static ThisAddIn ThisAddIn
        {
            get { return _ThisAddIn; }
            set
            {
                if (_ThisAddIn == null || value == null)
                {
                    _ThisAddIn = value;
                }
            }
        }

        internal static Microsoft.Office.Tools.Outlook.Factory Factory
        {
            get { return _factory; }
            set
            {
                if (_factory == null || value == null)
                {
                    _factory = value;
                }
            }
        }
    }
}
