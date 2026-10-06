# Test double for PlanSwift's COM server, dot-sourced by the bridge scripts when
# PRECISE_BRIDGE_MOCK points here. It exposes the same member names as the PlanSwift9 type
# library and persists renames into the fixture job folder like PlanSwift does.
# Environment knobs:
#   PRECISE_MOCK_PAGES     Pages folder of the fixture job (required)
#   PRECISE_MOCK_FAIL_ON   Throw when a page is renamed to this name
#   PRECISE_MOCK_ALTER_ON  Store this name with " (2)" appended
#   PRECISE_MOCK_MUTATE_ON Changing a page to this name also changes its Scale property
#   PRECISE_MOCK_QTY_ON    Changing a page to this name changes a takeoff quantity
#   PRECISE_MOCK_LOG       File that receives one line per COM call that changes state
#   PRECISE_MOCK_TAKEOFF_ITEMS  Extra takeoff items to create (large jobs)
#   PRECISE_MOCK_QTY_DELAY_MS   Delay for every Qty read (PlanSwift recalculating)
#   PRECISE_MOCK_HANG_ON        Name of a COM method that never returns (e.g. NewChangeGroup)
if (-not ('PreciseMock.App' -as [type])) {
  # Windows PowerShell 5.1 does not reference System.Xml by default; PowerShell 7 does.
  $references = @{}
  if ($PSVersionTable.PSEdition -ne 'Core') { $references.ReferencedAssemblies = @('System.Xml') }
  Add-Type @references -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Xml;

namespace PreciseMock {
  public class Prop {
    private string name; private string value;
    public Prop(string name, string value) { this.name = name; this.value = value; }
    public string Name { get { return name; } }
    public string Value { get { return value; } set { this.value = value; } }
    public string ResultAsString() { return value; }
  }

  public class Item {
    public Item Parent;
    public List<Item> Children = new List<Item>();
    public List<Prop> Props = new List<Prop>();
    public string Guid; public string Type; public string XmlPath;
    private string name;
    public Item(string name, string guid, string type) { this.name = name; Guid = guid; Type = type; }

    public string Name {
      get { return name; }
      set {
        string stored = value;
        if (value == Env("PRECISE_MOCK_FAIL_ON")) throw new InvalidOperationException("Mock failure renaming to " + value);
        if (value == Env("PRECISE_MOCK_ALTER_ON")) stored = value + " (2)";
        if (value == Env("PRECISE_MOCK_MUTATE_ON")) SetProp("Scale", "1/8\" = 1'-0\"");
        if (value == Env("PRECISE_MOCK_QTY_ON")) App.Current.BumpQuantity();
        name = stored;
        if (XmlPath != null) {
          XmlDocument doc = new XmlDocument();
          doc.Load(XmlPath);
          foreach (XmlElement p in doc.SelectNodes("/Item/Properties/Property")) {
            if (p.GetAttribute("Name") == "Name") p.InnerText = stored;
          }
          doc.Save(XmlPath);
        }
        App.Log("Name " + Guid + " " + stored);
      }
    }
    public string ItemType { get { return Type; } }
    public string GUID() { return Guid; }
    public string FullPath() { return Parent == null ? "" : Parent.FullPath() + "\\" + name; }
    public int ChildCount() { return Children.Count; }
    public Item ChildItem(int index) { return Children[index]; }
    public int PropertyCount() { return Props.Count; }
    public Prop PropertyItem(int index) { return Props[index]; }
    public string GetPropertyResultAsString(string property, string fallback) {
      int delay;
      if (property == "Qty" && int.TryParse(Env("PRECISE_MOCK_QTY_DELAY_MS"), out delay)) System.Threading.Thread.Sleep(delay);
      foreach (Prop p in Props) if (p.Name == property) return p.Value;
      return fallback;
    }
    public Item GetItemByGUID(string guid) {
      foreach (Item c in Children) {
        if (string.Equals(c.Guid, guid, StringComparison.OrdinalIgnoreCase)) return c;
        Item found = c.GetItemByGUID(guid);
        if (found != null) return found;
      }
      return null;
    }
    public Item Child(string childName) {
      foreach (Item c in Children) if (string.Equals(c.name, childName, StringComparison.OrdinalIgnoreCase)) return c;
      return null;
    }
    public Item Add(Item child) { child.Parent = this; Children.Add(child); return child; }
    public void SetProp(string property, string value) {
      foreach (Prop p in Props) if (p.Name == property) { p.Value = value; return; }
      Props.Add(new Prop(property, value));
    }
    static string Env(string key) { return Environment.GetEnvironmentVariable(key); }
  }

  public class App {
    public static App Current;
    public Item RootItem = new Item("", "ROOT", "Root");
    public Item TakeoffItem;
    public int ChangeGroups; public int Posts;

    public App(string pagesDir) {
      Current = this;
      Item storages = RootItem.Add(new Item("Storages", "S", "Folder"));
      Item job = storages.Add(new Item("Fixture Job", "JOB", "Job"));
      Item pages = job.Add(new Item("Pages", "PAGES", "Folder"));
      Load(pages, pagesDir);
      TakeoffItem = job.Add(new Item("Takeoff", "TAKEOFF", "Folder"));
      Item wall = TakeoffItem.Add(new Item("Walls", "T1", "Linear"));
      wall.SetProp("Qty", "125.5");
      Item section = wall.Add(new Item("Section", "T1S", "Section"));
      section.SetProp("Qty", "125.5");
      Item floor = TakeoffItem.Add(new Item("Floor", "T2", "Area"));
      floor.SetProp("Qty", "860");
      int extra;
      if (int.TryParse(Environment.GetEnvironmentVariable("PRECISE_MOCK_TAKEOFF_ITEMS"), out extra)) {
        Item folder = TakeoffItem.Add(new Item("More", "T3", "Folder"));
        for (int i = 0; i < extra; i++) folder.Add(new Item("Item " + i, "TX" + i, "Count")).SetProp("Qty", i.ToString());
      }
    }

    void Load(Item parent, string dir) {
      foreach (string sub in Directory.GetDirectories(dir)) {
        string xml = Path.Combine(sub, "Data.xml");
        if (!File.Exists(xml)) continue;
        XmlDocument doc = new XmlDocument();
        doc.Load(xml);
        XmlElement root = doc.DocumentElement;
        string name = Path.GetFileName(sub);
        Item item = new Item(name, root.GetAttribute("GUID"), root.GetAttribute("Class"));
        foreach (XmlElement p in doc.SelectNodes("/Item/Properties/Property")) {
          if (p.GetAttribute("Name") == "Name") item = new Item(p.InnerText, root.GetAttribute("GUID"), root.GetAttribute("Class"));
        }
        foreach (XmlElement p in doc.SelectNodes("/Item/Properties/Property")) item.Props.Add(new Prop(p.GetAttribute("Name"), p.InnerText));
        item.XmlPath = xml;
        parent.Add(item);
        Load(item, sub);
      }
    }

    public Item Root() { return RootItem; }
    public string Edition() { return "Mock"; }
    public Item GetItem(string fullPath) {
      string[] parts = fullPath.Trim('\\').Split('\\');
      Item node = RootItem;
      for (int i = 0; i < parts.Length; i++) {
        string part = parts[i];
        if (i == 0 && part == "Job") { node = RootItem.Child("Storages").Child("Fixture Job"); continue; }
        node = node == null ? null : node.Child(part);
      }
      return node;
    }
    public void NewChangeGroup(string groupName) {
      if (Environment.GetEnvironmentVariable("PRECISE_MOCK_HANG_ON") == "NewChangeGroup") System.Threading.Thread.Sleep(600000);
      ChangeGroups++;
      Log("NewChangeGroup " + groupName);
    }
    public void PostChanges() { Posts++; Log("PostChanges"); }
    public void BumpQuantity() { TakeoffItem.Children[1].SetProp("Qty", "0"); }

    public static void Log(string line) {
      string path = Environment.GetEnvironmentVariable("PRECISE_MOCK_LOG");
      if (!string.IsNullOrEmpty(path)) File.AppendAllText(path, line + "\n");
    }
  }
}
'@
}

function Connect-PlanSwift {
  $app = New-Object PreciseMock.App -ArgumentList $env:PRECISE_MOCK_PAGES
  return [pscustomobject]@{ App = $app; How = 'mock'; ProcessCount = 1 }
}
