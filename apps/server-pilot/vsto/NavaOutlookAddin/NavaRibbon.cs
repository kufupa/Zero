using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using Office = Microsoft.Office.Core;

namespace NavaOutlookAddin
{
    [ComVisible(true)]
    public class NavaRibbon : Office.IRibbonExtensibility
    {
        private Office.IRibbonUI _ribbon;

        public string GetCustomUI(string ribbonID)
        {
            return GetResourceText("NavaOutlookAddin.NavaRibbon.xml");
        }

        public void Ribbon_Load(Office.IRibbonUI ribbonUI)
        {
            _ribbon = ribbonUI;
        }

        public void OnToggleTaskPane(Office.IRibbonControl control)
        {
            ThisAddIn.Instance?.ToggleTaskPane();
        }

        private static string GetResourceText(string resourceName)
        {
            var assembly = Assembly.GetExecutingAssembly();
            using (var stream = assembly.GetManifestResourceStream(resourceName))
            {
                if (stream == null)
                {
                    return @"<customUI xmlns=""http://schemas.microsoft.com/office/2009/07/customui"">
  <ribbon>
    <tabs>
      <tab id=""NavaTab"" label=""Nava"">
        <group id=""NavaGroupHome"" label=""Nava"">
          <button id=""NavaToggleHome"" label=""Nava Assistant"" size=""large"" onAction=""OnToggleTaskPane"" />
        </group>
      </tab>
      <tab idMso=""TabMail"">
        <group id=""NavaGroup"" label=""Nava"">
          <button id=""NavaToggle"" label=""Nava Assistant"" size=""large"" onAction=""OnToggleTaskPane"" />
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>";
                }
                using (var reader = new StreamReader(stream))
                {
                    return reader.ReadToEnd();
                }
            }
        }
    }
}
