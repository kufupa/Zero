using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Office.Tools;
using Office = Microsoft.Office.Core;
using Outlook = Microsoft.Office.Interop.Outlook;

namespace NavaOutlookAddin
{
    public partial class ThisAddIn
    {
        internal static ThisAddIn Instance { get; private set; }

        private CustomTaskPane _taskPane;
        private TaskPaneControl _control;
        private Outlook.Explorer _explorer;

        protected override Office.IRibbonExtensibility CreateRibbonExtensibilityObject()
        {
            return new NavaRibbon();
        }

        private void ThisAddIn_Startup(object sender, System.EventArgs e)
        {
            Instance = this;
            EnsurePane(false);
        }

        private void EnsurePane(bool showErrorDialog)
        {
            if (_taskPane != null) return;
            try
            {
                _control = new TaskPaneControl(this.Application);
                _explorer = this.Application.ActiveExplorer();
                if (_explorer != null)
                {
                    _taskPane = this.CustomTaskPanes.Add(_control, "Nava AI Reservationist", _explorer);
                    _explorer.SelectionChange += Explorer_SelectionChange;
                }
                else
                {
                    _taskPane = this.CustomTaskPanes.Add(_control, "Nava AI Reservationist");
                }
                _taskPane.DockPosition = Office.MsoCTPDockPosition.msoCTPDockPositionRight;
                _taskPane.Width = 380;
                _taskPane.Visible = true;
            }
            catch (Exception ex)
            {
                // Pane/WebView2 failures must not unload the VSTO add-in.
                if (showErrorDialog)
                {
                    MessageBox.Show(
                        "Nava could not open the side pane.\n\n" + ex.Message,
                        "Nava Outlook Assistant");
                }
            }
        }

        private void Explorer_SelectionChange()
        {
            try
            {
                _control?.NotifySelectionChanged();
            }
            catch (COMException)
            {
                // Mailbox-specific COM failures must not escape Outlook's event callback.
            }
            catch (Exception)
            {
            }
        }

        public void ToggleTaskPane()
        {
            if (_taskPane == null)
            {
                EnsurePane(true);
                return;
            }
            try
            {
                _taskPane.Visible = true;
                if (_taskPane.Width < 200)
                {
                    _taskPane.Width = 380;
                }
            }
            catch (Exception)
            {
                _taskPane = null;
                EnsurePane(true);
            }
        }

        private void ThisAddIn_Shutdown(object sender, System.EventArgs e)
        {
            if (_explorer != null)
            {
                _explorer.SelectionChange -= Explorer_SelectionChange;
                Marshal.ReleaseComObject(_explorer);
                _explorer = null;
            }
            _taskPane = null;
            _control = null;
            Instance = null;
        }

        #region VSTO generated code
        private void InternalStartup()
        {
            Instance = this;
            this.Startup += new System.EventHandler(ThisAddIn_Startup);
            this.Shutdown += new System.EventHandler(ThisAddIn_Shutdown);
        }
        #endregion
    }
}
