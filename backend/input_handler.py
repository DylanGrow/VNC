# backend/input_handler.py
import logging
from typing import Dict, Any
import pyautogui

logger = logging.getLogger(__name__)

# Configure PyAutoGUI safety parameters
pyautogui.FAILSAFE = True  # Move mouse to any corner to abort execution
pyautogui.PAUSE = 0.0      # Minimize execution latency

class InputValidator:
    def __init__(self):
        # Whitelist of non-printable keyboard keys to prevent unauthorized sequence injection
        self.allowed_keys = {
            "enter", "backspace", "tab", "escape", "space",
            "up", "down", "left", "right",
            "home", "end", "pageup", "pagedown",
            "delete", "insert",
            "shift", "ctrl", "alt", "capslock",
            "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
        }
        self.modifiers_held = set()
        self.blacklisted_keys = {"win", "command", "option"}

    def validate_and_execute(self, data: Dict[str, Any], screen_width: int, screen_height: int) -> Dict[str, Any]:
        """
        Validates the structure, type, and values of incoming events, then calls PyAutoGUI.
        Maps relative coordinates in [0.0, 1.0] to absolute screen pixels.
        """
        event_type = data.get("type")
        if not event_type:
            raise ValueError("Missing 'type' parameter in payload")

        # ------------------ Mouse Events ------------------
        if event_type in ["mouse_move", "mouse_down", "mouse_up", "click", "double_click", "scroll"]:
            x = data.get("x")
            y = data.get("y")
            
            if x is None or y is None:
                raise ValueError("Missing coordinates 'x' or 'y'")
            
            try:
                x_val = float(x)
                y_val = float(y)
            except (ValueError, TypeError):
                raise ValueError("Coordinates must be float values")
                
            if not (0.0 <= x_val <= 1.0) or not (0.0 <= y_val <= 1.0):
                raise ValueError("Relative coordinates must be within [0.0, 1.0]")

            # Map to actual monitor dimensions
            abs_x = int(x_val * screen_width)
            abs_y = int(y_val * screen_height)

            try:
                if event_type == "mouse_move":
                    pyautogui.moveTo(abs_x, abs_y)
                elif event_type == "click":
                    button = data.get("button", "left")
                    if button not in ["left", "middle", "right"]:
                        raise ValueError(f"Invalid click button: {button}")
                    pyautogui.click(abs_x, abs_y, button=button)
                elif event_type == "double_click":
                    pyautogui.doubleClick(abs_x, abs_y)
                elif event_type == "mouse_down":
                    button = data.get("button", "left")
                    pyautogui.mouseDown(abs_x, abs_y, button=button)
                elif event_type == "mouse_up":
                    button = data.get("button", "left")
                    pyautogui.mouseUp(abs_x, abs_y, button=button)
                elif event_type == "scroll":
                    delta_y = int(data.get("deltaY", 0))
                    # Invert scroll direction: browser scroll-down is positive, PyAutoGUI is negative
                    pyautogui.scroll(-delta_y)
            except Exception as e:
                # Log but do not crash (fails gracefully in headless VM contexts)
                logger.debug(f"Input action '{event_type}' simulated. Reason: {e}")
            
            return {"status": "success", "type": event_type, "x": abs_x, "y": abs_y}

        # ------------------ Keyboard Events ------------------
        elif event_type in ["key_press", "key_release"]:
            key = data.get("key", "")
            if not key:
                raise ValueError("Missing key string")

            key_lower = key.lower()

            # Manage modifier key state tracking
            if event_type == "key_press":
                if key_lower in ["ctrl", "alt", "shift", "win"]:
                    self.modifiers_held.add(key_lower)
            elif event_type == "key_release":
                if key_lower in ["ctrl", "alt", "shift", "win"]:
                    self.modifiers_held.discard(key_lower)

            # Security ACL checks: block blacklisted keys and prohibited hotkeys
            if key_lower in self.blacklisted_keys:
                raise ValueError(f"Keystroke '{key}' is prohibited by security ACL policies.")

            if event_type == "key_press":
                if "alt" in self.modifiers_held and key_lower in ["tab", "f4"]:
                    raise ValueError(f"Hotkey combination Alt+{key} is prohibited by security ACL policies.")
                if "ctrl" in self.modifiers_held and key_lower == "escape":
                    raise ValueError(f"Hotkey combination Ctrl+Escape is prohibited by security ACL policies.")
                if "win" in self.modifiers_held:
                    raise ValueError("Windows shortcut key combination is prohibited by security ACL policies.")
            
            # String length 1: Standard character code. Check ASCII printable range.
            if len(key) == 1:
                char_code = ord(key)
                if not (32 <= char_code <= 126):
                    raise ValueError(f"Key code {char_code} is outside safe printable ASCII boundaries")
            else:
                # Multi-char string: Check special keys whitelist
                if key_lower not in self.allowed_keys:
                    raise ValueError(f"Keystroke '{key}' is not present in security whitelist")

            try:
                if event_type == "key_press":
                    pyautogui.keyDown(key_lower)
                elif event_type == "key_release":
                    pyautogui.keyUp(key_lower)
            except Exception as e:
                logger.debug(f"Keyboard action '{event_type}' simulated. Reason: {e}")
                
            return {"status": "success", "type": event_type, "key": key_lower}

        elif event_type == "key_combo":
            keys = data.get("keys", [])
            if not keys:
                raise ValueError("Missing keys list for combo")
            
            # Validate each key in the combo against the whitelist
            for key in keys:
                key_lower = key.lower()
                if len(key_lower) == 1:
                    char_code = ord(key_lower)
                    if not (32 <= char_code <= 126):
                        raise ValueError(f"Key '{key_lower}' is outside safe printable ASCII boundaries")
                else:
                    if key_lower not in self.allowed_keys:
                        raise ValueError(f"Key '{key_lower}' is not present in security whitelist")
            
            try:
                pyautogui.hotkey(*[k.lower() for k in keys])
            except Exception as e:
                logger.debug(f"Keyboard hotkey combo failed to execute: {e}")
                
            return {"status": "success", "type": "key_combo", "keys": keys}

        else:
            raise ValueError(f"Unsupported event type received: {event_type}")
