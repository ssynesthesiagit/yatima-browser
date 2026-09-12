"""Exercise the installed release's actual layout branch, without providers."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest

from assistant_draft_patch import AFTER, BEFORE, BUNDLE, PatchError, transform


class AssistantDraftPatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(os.environ.get("YATIMA_ASSISTANT_TEST_ROOT", Path.home() / ".local/share/yatima-browser/addons/assistant"))
        cls.source = (root / BUNDLE).read_text()
        cls.original = cls.source.replace(AFTER, BEFORE, 1)

    def test_background_loading_keeps_chat_layout(self):
        patched = transform(self.original)
        # Extract the actual compiled component. Stubs expose its returned
        # element tree without invoking models, extension APIs or child hooks.
        component = patched.split("const xt=", 1)[1].split(",pt=", 1)[0]
        harness = f"""
const e={{jsx:(type,props)=>({{type,props}}),jsxs:(type,props)=>({{type,props}})}};
const ve='header',ye='outlet';let state;
const M=()=>state;const layout={component};
const output=[];
for(const selected of [false,true])for(const loading of [false,true]){{
 state={{providers:[],selectedProvider:selected?{{id:'local'}}:null,messages:[],isLoading:loading}};
 const rendered=layout();output.push({{selected,loading,chat:Array.isArray(rendered.props.children)}});
}}
console.log(JSON.stringify(output));
"""
        result = subprocess.run(["node", "-e", harness], capture_output=True, text=True, check=True)
        for case in json.loads(result.stdout):
            self.assertEqual(case["chat"], case["selected"])

    def test_exact_idempotence(self):
        patched = transform(self.original)
        self.assertEqual(patched, transform(patched))
        self.assertNotEqual(hashlib.sha256(patched.encode()).digest(), hashlib.sha256(self.original.encode()).digest())

    def test_changed_bundle_is_rejected(self):
        with self.assertRaises(PatchError):
            transform(self.original + "\n// unrelated edit")

    def test_partial_patch_is_rejected(self):
        with self.assertRaises(PatchError):
            transform(self.original.replace("return i||!s?", "return i?", 1))


if __name__ == "__main__":
    unittest.main()
