using System;
using System.Runtime.InteropServices;
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
            _control = new TaskPaneControl(this.Application);
            _taskPane = this.CustomTaskPanes.Add(_control, "Nava AI Reservationist");
            _taskPane.Width = 380;
            _taskPane.Visible = true;

            _explorer = this.Application.ActiveExplorer();
            if (_explorer != null)
            {
                _explorer.SelectionChange += Explorer_SelectionChange;
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
            if (_taskPane != null)
            {
                _taskPane.Visible = !_taskPane.Visible;
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
            if (_taskPane != null)
            {
                this.CustomTaskPanes.Remove(_taskPane);
                _taskPane.Dispose();
                _taskPane = null;
            }
            if (_control != null)
            {
                _control.Dispose();
                _control = null;
            }
            Instance = null;
        }

        #region VSTO generated code
        private void InternalStartup()
        {
            this.Startup += new System.EventHandler(ThisAddIn_Startup);
            this.Shutdown += new System.EventHandler(ThisAddIn_Shutdown);
        }
        #endregion
    }
}
